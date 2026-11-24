// Isi file: kelola penjual di panel admin: daftar penjual, antrean verifikasi, detail penjual, dan aksi status
// (verifikasi, minta perbaikan, tangguhkan, aktifkan lagi, tutup hari ini). Alurnya routes/admin.ts →
// handlers/admin.handler.ts → file ini → database. Semua tingkat admin boleh melihat; aksi (POST) hanya untuk admin
// ops dan super. Setiap aksi yang mengubah data dicatat di log audit (`merchant.<aksi>`) beserta kolom sebelum/sesudah.
//
// Status verifikasi toko: `pending` = baru mendaftar, `needs_fix` = diminta memperbaiki data, `verified` = lolos dan
// tampil di katalog, `suspended` = ditangguhkan admin (tidak tampil).
import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { AppError } from "../utils/errors";
import { recordAudit, listAuditLogs, withTransaction } from "./admin-audit.service";

/** Status verifikasi toko, sama dengan nilai kolom `merchants.verification_status`. */
export const STATUSES = ["pending", "needs_fix", "verified", "suspended"] as const;
type Status = (typeof STATUSES)[number];

// Aturan setiap aksi admin terhadap toko: `action` = nama aksi di log audit, `from` = status asal yang diizinkan,
// `set` = potongan SQL yang mengubah kolom, `cols` = kolom yang dicatat sebelum/sesudah di log audit, `reason` = aksi
// ini memakai alasan (`note` disimpan sebagai catatan perbaikan, `suspend` sebagai alasan penangguhan).
type Rule = { action: string; from: Status[]; set: string; cols: string[]; reason?: "note" | "suspend" };
const RULES: Record<string, Rule> = {
  verify: {
    action: "merchant.verify",
    from: ["pending", "needs_fix"],
    set: "verification_status='verified', verified_at=UTC_TIMESTAMP(), verification_note=NULL",
    cols: ["verification_status", "verified_at", "verification_note"],
  },
  "request-fix": {
    action: "merchant.request_fix",
    from: ["pending"],
    set: "verification_status='needs_fix', verification_note=?",
    cols: ["verification_status", "verification_note"],
    reason: "note",
  },
  suspend: {
    action: "merchant.suspend",
    from: ["pending", "needs_fix", "verified"],
    set: "verification_status='suspended', verified_at=NULL, suspended_at=UTC_TIMESTAMP(), suspended_reason=?",
    cols: ["verification_status", "verified_at", "suspended_at", "suspended_reason"],
    reason: "suspend",
  },
  reactivate: {
    action: "merchant.reactivate",
    from: ["suspended"],
    set: "verification_status='verified', verified_at=UTC_TIMESTAMP(), suspended_at=NULL, suspended_reason=NULL",
    cols: ["verification_status", "verified_at", "suspended_at", "suspended_reason"],
  },
  "close-today": {
    action: "merchant.close_today",
    from: ["verified"],
    set: "is_open=FALSE",
    cols: ["is_open"],
  },
};
/** Nama aksi yang tersedia; routes/admin.ts membuat satu rute POST /merchants/:id/<nama> untuk setiap nama. */
export const ACTION_NAMES = Object.keys(RULES);

// Daftar periksa kelengkapan toko untuk membantu admin memutuskan verifikasi: nomor WA valid, alamat terisi, punya
// titik temu aktif, punya menu aktif, ada menu aktif berfoto, dan jam buka sebelum jam tutup.
// shortcut: opening_hours hanya cek jam buka < jam tutup (kolom punya default, jadi hampir selalu true); upgrade bila
// jam buka bisa kosong.
const CHECKLIST_SQL = `
  m.wa_number REGEXP '^08[0-9]{8,11}$' AS chk_wa_valid,
  TRIM(m.address) <> '' AS chk_address,
  EXISTS (SELECT 1 FROM merchant_pickup_points mp JOIN pickup_points p ON p.id = mp.pickup_point_id WHERE mp.merchant_id = m.id AND p.is_active) AS chk_pickup_point,
  EXISTS (SELECT 1 FROM menus x WHERE x.merchant_id = m.id AND x.is_active AND x.deleted_at IS NULL) AS chk_active_menu,
  EXISTS (SELECT 1 FROM menus x WHERE x.merchant_id = m.id AND x.is_active AND x.deleted_at IS NULL AND x.image_url IS NOT NULL AND x.image_url <> '') AS chk_menu_with_photo,
  m.open_time < m.close_time AS chk_opening_hours`;
const CHECK_KEYS = ["wa_valid", "address", "pickup_point", "active_menu", "menu_with_photo", "opening_hours"];
// Kolom chk_* hasil query menjadi objek checklist berisi true/false.
const toChecklist = (row: RowDataPacket) =>
  Object.fromEntries(CHECK_KEYS.map((key) => [key, Boolean(row[`chk_${key}`])]));
// Penyaring untuk membuang kolom chk_* dari data yang dikirim (sudah dipindah ke checklist).
const isNotChecklistColumn = ([key]: [string, unknown]) => !key.startsWith("chk_");

/**
 * Tanda khusus LIKE (%, _, dan garis miring terbalik) di kata kunci dibuat harfiah supaya tidak menjadi pola. Dipakai
 * juga daftar pembeli (admin-customer.service).
 * @param text kata kunci dari pengguna
 * @returns kata kunci yang aman dipakai di dalam pola LIKE
 */
export const escapeLike = (text: string) => text.replace(/[\\%_]/g, "\\$&");

/**
 * Daftar penjual per halaman, terbaru dulu, dengan filter opsional.
 * @param filter `q` = kata kunci nama usaha atau nomor WA, `status` = status verifikasi, `open` = "1" toko buka /
 *               "0" toko tutup, `page` dan `limit` = halaman
 * @returns `{ data, meta: { page, limit, total } }`; tiap baris memuat nama pemilik dan jumlah menu aktif
 * @throws 400 status tidak dikenal atau `open` bukan 1/0
 */
export async function listMerchants(filter: {
  q?: string;
  status?: string;
  open?: string;
  page: number;
  limit: number;
}) {
  // 1. Susun syarat dari filter yang diisi; nilai yang tidak dikenal ditolak.
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.status !== undefined) {
    if (!STATUSES.includes(filter.status as Status))
      throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", { status: ["Status tidak dikenal."] });
    where.push("m.verification_status = ?");
    args.push(filter.status);
  }
  if (filter.open !== undefined) {
    if (filter.open !== "0" && filter.open !== "1")
      throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", { open: ["Harus 1 atau 0."] });
    where.push("m.is_open = ?");
    args.push(Number(filter.open));
  }
  if (filter.q) {
    where.push("(LOWER(m.business_name) LIKE LOWER(?) OR m.wa_number LIKE ?)");
    const like = `%${escapeLike(filter.q)}%`;
    args.push(like, like);
  }
  // 2. Ambil satu halaman, lalu hitung total dengan syarat yang sama.
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT m.id, m.business_name, u.full_name AS owner_name, m.wa_number, m.verification_status, m.is_open,
            (SELECT COUNT(*) FROM menus x WHERE x.merchant_id = m.id AND x.is_active AND x.deleted_at IS NULL) AS menu_count,
            m.created_at
     FROM merchants m JOIN users u ON u.id = m.user_id ${whereSql}
     ORDER BY m.id DESC LIMIT ? OFFSET ?`,
    [...args, filter.limit, (filter.page - 1) * filter.limit],
  );
  const [counts] = await db.query<RowDataPacket[]>(`SELECT COUNT(*) AS total FROM merchants m ${whereSql}`, args);
  return {
    data: rows.map((row) => ({ ...row, is_open: Boolean(row.is_open), menu_count: Number(row.menu_count) })),
    meta: { page: filter.page, limit: filter.limit, total: Number(counts[0].total) },
  };
}

/**
 * Antrean verifikasi: toko `pending` dan `needs_fix`, yang paling lama mendaftar di atas.
 * @returns daftar toko beserta checklist kelengkapan dan `updated_after_note` = `true` bila profil toko atau salah satu
 *          menunya diubah setelah admin terakhir kali meminta perbaikan (tanda bahwa penjual sudah menanggapi)
 */
export async function getVerificationQueue() {
  // 1. Ambil toko di antrean beserta kolom checklist dan tanda sudah diperbarui setelah diminta perbaikan.
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT m.id, m.business_name, u.full_name AS owner_name, m.wa_number, m.verification_status, m.verification_note, m.created_at,
            ${CHECKLIST_SQL},
            COALESCE(GREATEST(m.updated_at, COALESCE((SELECT MAX(x.updated_at) FROM menus x WHERE x.merchant_id = m.id), m.updated_at))
              > (SELECT MAX(l.created_at) FROM admin_audit_logs l WHERE l.target_type = 'merchant' AND l.target_id = m.id AND l.action = 'merchant.request_fix'), 0) AS updated_after_note
     FROM merchants m JOIN users u ON u.id = m.user_id
     WHERE m.verification_status IN ('pending','needs_fix')
     ORDER BY m.created_at ASC, m.id ASC`,
  );
  // 2. Pindahkan kolom chk_* ke objek checklist dan ubah tandanya menjadi boolean.
  return rows.map((row) => {
    const { updated_after_note, ...rest } = row;
    const lean = Object.fromEntries(Object.entries(rest).filter(isNotChecklistColumn));
    return { ...lean, checklist: toChecklist(row), updated_after_note: Boolean(updated_after_note) };
  });
}

/**
 * Detail satu penjual untuk admin: profil toko, data pemilik, titik temu, checklist, dan 10 log audit terbaru untuk
 * toko ini. Kolom rekening pencairan (`payout_*`) sengaja tidak dikirim karena detail ini terbuka untuk semua tingkat
 * admin, sedangkan rekening hanya untuk admin super lewat menu pencairan.
 * @param id id toko yang sudah diperiksa handler
 * @returns profil toko, `owner`, `pickup_points`, `checklist`, dan `recent_logs`
 * @throws 404 toko tidak ditemukan
 */
export async function getMerchantDetail(id: number) {
  // 1. Ambil toko beserta pemilik, jenis usaha, jumlah menu aktif, dan kolom checklist.
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT m.*, u.full_name AS owner_full_name, u.phone AS owner_phone, u.email AS owner_email, u.is_active AS owner_is_active,
            t.name AS merchant_type_name,
            (SELECT COUNT(*) FROM menus x WHERE x.merchant_id = m.id AND x.is_active AND x.deleted_at IS NULL) AS menu_count,
            ${CHECKLIST_SQL}
     FROM merchants m JOIN users u ON u.id = m.user_id JOIN merchant_types t ON t.id = m.merchant_type_id WHERE m.id = ?`,
    [id],
  );
  if (!rows[0]) throw new AppError(404, "NOT_FOUND", "Penjual tidak ditemukan.");
  const merchant = rows[0];
  // 2. Ambil titik temu toko dan 10 log audit terbaru untuk toko ini.
  const [points] = await db.query<RowDataPacket[]>(
    "SELECT p.id, p.name FROM merchant_pickup_points mp JOIN pickup_points p ON p.id = mp.pickup_point_id WHERE mp.merchant_id = ? ORDER BY p.name",
    [id],
  );
  const { data: logs } = await listAuditLogs({ page: 1, limit: 10, targetType: "merchant", targetId: String(id) });
  // 3. Profil = semua kolom toko kecuali kolom checklist, kolom pemilik (dikirim terpisah di `owner`), dan rekening
  //    pencairan.
  const profile = Object.fromEntries(
    Object.entries(merchant).filter(
      (entry) => isNotChecklistColumn(entry) && !entry[0].startsWith("owner_") && !entry[0].startsWith("payout_"),
    ),
  );
  return {
    ...profile,
    is_open: Boolean(merchant.is_open),
    menu_count: Number(merchant.menu_count),
    owner: {
      full_name: merchant.owner_full_name,
      phone: merchant.owner_phone,
      email: merchant.owner_email,
      is_active: Boolean(merchant.owner_is_active),
    },
    pickup_points: points,
    checklist: toChecklist(merchant),
    recent_logs: logs,
  };
}

/**
 * Menjalankan satu aksi status terhadap toko sesuai aturan di RULES: verifikasi (dari `pending`/`needs_fix`), minta
 * perbaikan (dari `pending`, alasan wajib), tangguhkan (dari selain `suspended`, alasan wajib), aktifkan lagi (dari
 * `suspended`), atau tutup hari ini (toko `verified`; bila sudah tutup, tidak ada perubahan dan tidak ada log).
 * @param adminId id admin yang menjalankan
 * @param id      id toko
 * @param name    nama aksi dari ACTION_NAMES
 * @param reason  alasan (sudah diperiksa di rute); hanya disimpan untuk aksi yang memakai alasan
 * @returns detail toko sesudah aksi
 * @throws 404 toko tidak ditemukan, 409 status toko tidak cocok dengan status asal aksi ini
 */
export async function runMerchantAction(adminId: number, id: number, name: string, reason?: string) {
  const rule = RULES[name];
  await withTransaction(async (conn) => {
    const pick = (row: RowDataPacket) => Object.fromEntries(rule.cols.map((column) => [column, row[column]]));
    // 1. Kunci baris toko lalu pastikan statusnya boleh menjalankan aksi ini.
    const [found] = await conn.query<RowDataPacket[]>("SELECT * FROM merchants WHERE id = ? FOR UPDATE", [id]);
    if (!found[0]) throw new AppError(404, "NOT_FOUND", "Penjual tidak ditemukan.");
    if (!rule.from.includes(found[0].verification_status))
      throw new AppError(409, "CONFLICT", "Status penjual sudah berubah.");
    // 2. Tutup hari ini untuk toko yang sudah tutup: selesai tanpa perubahan dan tanpa log.
    if (name === "close-today" && !found[0].is_open) return;
    // 3. Alasan hanya dipakai aksi yang memerlukannya; aksi lain mengabaikan alasan yang ikut terkirim.
    if (!rule.reason) reason = undefined;
    // 4. Ubah kolom sesuai aturan, lalu catat kolom sebelum/sesudah dan alasannya di log audit.
    await conn.query(`UPDATE merchants SET ${rule.set} WHERE id = ?`, [...(rule.reason ? [reason] : []), id]);
    const [after] = await conn.query<RowDataPacket[]>("SELECT * FROM merchants WHERE id = ?", [id]);
    await recordAudit(conn, {
      adminId,
      action: rule.action,
      targetType: "merchant",
      targetId: id,
      reason,
      before: pick(found[0]),
      after: pick(after[0]),
    });
  });
  return getMerchantDetail(id);
}
