// Isi file: promo platform (voucher yang dibuat admin dan ditanggung platform, `merchant_id` kosong) dan pengaturan
// aplikasi yang diubah admin: biaya layanan dan nomor WhatsApp layanan pelanggan (CS). Alurnya routes/admin.ts →
// handlers/admin.handler.ts → file ini → database. Promo boleh dikelola admin ops dan super; mengubah pengaturan
// (PUT /admin/settings/...) hanya admin super. Promo platform tidak pernah dihapus, hanya diarsipkan (`archived_at`)
// supaya riwayat pesanan tetap utuh. Semua perubahan dicatat di log audit. Pemeriksa isian promo dan
// beberapa alat kecil di sini juga dipakai promo toko (merchant-promo.service).
//
// Istilah promo: jenis `percent` = potongan persen (boleh dibatasi `max_discount`), `fixed` = potongan rupiah,
// `free_service_fee` = gratis biaya layanan. `quota` = batas pemakaian total (kosong = tanpa batas), `per_user_limit` =
// batas pemakaian per pembeli, `used_count` = sudah dipakai berapa kali, `is_public` = tampil dan bisa diklaim pembeli.
// Pengaturan disimpan di tabel app_settings sebagai pasangan kunci-nilai teks.
import { RowDataPacket } from "mysql2";
import { z } from "zod";
import db from "../config/db";
import { AppError } from "../utils/errors";
import { fieldsFromIssues, parse } from "../middleware/validate";
import { Conn, recordAudit, withTransaction, lockRow, withBooleanFlags, setArchived } from "./admin-audit.service";

// Aturan angka bulat dengan batas bawah; `label` dipakai di pesan galat.
const integerField = (label: string, min: number) =>
  z
    .number({ error: `${label} wajib diisi.` })
    .int(`${label} harus bilangan bulat.`)
    .min(min, `${label} minimal ${min}.`);
// Waktu ISO 8601 dengan "Z" atau zona waktu tertulis; teks longgar ("1", "March 7") ditolak.
const dateTimeField = (message: string) =>
  z
    .string({ error: message })
    .pipe(z.iso.datetime({ offset: true, error: message }))
    .transform((text) => new Date(text));

// Aturan isian promo. Web punya pemeriksa yang sama untuk pesan cepat di layar, tetapi backend inilah penentunya.
// `usedCount` = pemakaian yang sudah terjadi; kuota baru tidak boleh lebih kecil darinya.
const promoSchema = (usedCount: number) =>
  z
    .object({
      description: z.string({ error: "Deskripsi tidak valid." }).trim().max(255, "Maksimal 255 karakter.").nullish(),
      type: z.enum(["percent", "fixed", "free_service_fee"], { error: "Pilih jenis promo." }),
      value: z.number({ error: "Nilai wajib diisi." }).int("Nilai harus bilangan bulat."),
      max_discount: integerField("Maks potongan", 1).nullish(),
      min_subtotal: integerField("Min belanja", 0),
      quota: integerField("Kuota", 1).nullish(),
      per_user_limit: integerField("Batas per pembeli", 1),
      starts_at: dateTimeField("Waktu mulai wajib diisi."),
      ends_at: dateTimeField("Waktu selesai wajib diisi."),
    })
    .superRefine((promo, context) => {
      const addError = (path: string, message: string) => context.addIssue({ code: "custom", path: [path], message });
      if (promo.type !== "free_service_fee") {
        if (promo.value < 1) addError("value", "Nilai minimal 1.");
        else if (promo.type === "percent" && promo.value > 100) addError("value", "Persen maksimal 100.");
      }
      if (promo.quota != null && promo.quota < usedCount)
        addError("quota", `Kuota tidak boleh di bawah yang sudah terpakai (${usedCount}).`);
      if (promo.ends_at <= promo.starts_at) addError("ends_at", "Waktu selesai harus setelah waktu mulai.");
    });

/** Kode promo: 3–30 huruf atau angka; spasi di ujung dibuang dan diubah ke huruf besar. */
export const promoCodeSchema = z
  .string({ error: "Kode wajib diisi." })
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{3,30}$/, "Kode 3–30 huruf besar atau angka.");
/** Kolom promo yang boleh diisi lewat isian (kode, status aktif, dan `is_public` diurus terpisah). */
export const PROMO_FIELDS = [
  "description",
  "type",
  "value",
  "max_discount",
  "min_subtotal",
  "quota",
  "per_user_limit",
  "starts_at",
  "ends_at",
] as const;

/**
 * Memeriksa dan merapikan isian promo (dipakai promo platform dan promo toko). Hanya kolom di PROMO_FIELDS yang
 * dibaca. Hasilnya dirapikan: deskripsi kosong menjadi null, nilai jenis gratis biaya layanan menjadi 0, dan batas
 * potongan hanya disimpan untuk jenis persen.
 * @param input     isi permintaan (bukan objek dianggap kosong)
 * @param usedCount pemakaian yang sudah terjadi (0 untuk promo baru)
 * @param checkCode `true` bila `code` juga harus diperiksa (saat membuat promo)
 * @returns `{ code, data }`: kode yang sudah dirapikan (atau undefined) dan kolom siap disimpan
 * @throws 400 dengan pesan per kolom bila ada isian yang tidak valid
 */
export function parsePromoInput(input: unknown, usedCount: number, checkCode = false) {
  // 1. Ambil hanya kolom promo yang dikenal.
  const body = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const picked = Object.fromEntries(PROMO_FIELDS.filter((key) => key in body).map((key) => [key, body[key]]));
  // 2. Periksa kode (bila diminta) dan kolom lain; semua pesan galat dikumpulkan dulu supaya dikirim sekaligus.
  const fields: Record<string, string[]> = {};
  let code: string | undefined;
  if (checkCode) {
    const codeResult = promoCodeSchema.safeParse(body.code);
    if (codeResult.success) code = codeResult.data;
    else fields.code = codeResult.error.issues.map((issue) => issue.message);
  }
  const result = promoSchema(usedCount).safeParse(picked);
  if (!result.success) Object.assign(fields, fieldsFromIssues(result.error.issues));
  if (Object.keys(fields).length || !result.success)
    throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", fields);
  // 3. Rapikan hasilnya sesuai jenis promo.
  const parsed = result.data;
  return {
    code,
    data: {
      description: parsed.description || null,
      type: parsed.type,
      value: parsed.type === "free_service_fee" ? 0 : parsed.value,
      max_discount: parsed.type === "percent" ? (parsed.max_discount ?? null) : null,
      min_subtotal: parsed.min_subtotal,
      quota: parsed.quota ?? null,
      per_user_limit: parsed.per_user_limit,
      starts_at: parsed.starts_at,
      ends_at: parsed.ends_at,
    },
  };
}

/**
 * Mengubah nilai kolom ke bentuk yang bisa dibandingkan dengan `!==`: tanggal menjadi angka milidetik, kosong menjadi
 * null. Dipakai untuk mendeteksi kolom yang benar-benar berubah.
 * @param value nilai kolom
 * @returns nilai yang siap dibandingkan
 */
export const comparableValue = (value: unknown) => (value instanceof Date ? value.getTime() : (value ?? null));

/**
 * Membaca `is_public` (voucher tampil dan bisa diklaim pembeli) dari isi permintaan.
 * @param body isi permintaan
 * @returns `true`/`false` sesuai isian, atau `undefined` bila tidak dikirim
 * @throws 400 bila dikirim tetapi bukan boolean
 */
export function parseIsPublic(body: unknown): boolean | undefined {
  const input = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (!("is_public" in input)) return undefined;
  if (typeof input.is_public !== "boolean") {
    throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", {
      is_public: ["Pilihan tampil di halaman toko tidak valid."],
    });
  }
  return input.is_public;
}
/**
 * Galat 409 untuk kode promo yang sudah dipakai promo lain (kode unik untuk seluruh promo platform dan toko).
 * @returns AppError siap dilempar
 */
export const duplicateCodeError = () =>
  new AppError(409, "CONFLICT", "Kode sudah dipakai.", { code: ["Kode sudah dipakai."] });

/**
 * Daftar promo platform, terbaru dulu: yang belum diarsipkan, atau hanya yang diarsipkan bila `archived` true.
 * @param archived `true` untuk daftar arsip
 * @returns baris promo dengan `is_active` dan `is_public` berupa boolean, serta `archived_at` (null bila tidak diarsipkan)
 */
export async function listPromos(archived = false) {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT * FROM promos WHERE merchant_id IS NULL AND archived_at IS ${archived ? "NOT " : ""}NULL ORDER BY id DESC`,
  );
  return rows.map(withBooleanFlags);
}

/**
 * Mengarsipkan atau memulihkan promo platform. Promo arsip tidak tampil di aplikasi dan tidak bisa dipakai saat
 * checkout, tetapi pesanan, pemakaian promo, dan klaim voucher yang menunjuknya tetap utuh. Idempoten; dicatat di log
 * audit `promo.archive` / `promo.restore`.
 * @param adminId id admin yang mengubah
 * @param idRaw   id promo dari URL
 * @param archive `true` untuk mengarsipkan, `false` untuk memulihkan
 * @returns promo sesudah diubah
 * @throws 404 promo platform tidak ada, 409 PROMO_IN_USE bila promo masih dipasang di pop-up atau banner yang belum
 *         diarsipkan
 */
export async function setPromoArchived(adminId: number, idRaw: unknown, archive: boolean) {
  const id = await setArchived(adminId, "promos", "promo", idRaw, archive, {
    where: "merchant_id IS NULL",
    notFound: "Promo tidak ditemukan.",
    // Promo yang masih dipasang di pop-up atau banner aktif tidak boleh diarsipkan; judulnya disebut di pesan.
    check: async (conn, promo) => {
      if (!archive) return;
      const [users] = await conn.query<RowDataPacket[]>(
        `SELECT title FROM popups WHERE promo_id = ? AND archived_at IS NULL
         UNION ALL SELECT title FROM banners WHERE promo_id = ? AND archived_at IS NULL`,
        [promo.id, promo.id],
      );
      if (users.length)
        throw new AppError(
          409,
          "PROMO_IN_USE",
          `Promo masih dipakai di pop-up atau banner: ${users.map((row) => row.title).join(", ")}.`,
        );
    },
  });
  const [[row]] = await db.query<RowDataPacket[]>("SELECT * FROM promos WHERE id = ?", [id]);
  return withBooleanFlags(row);
}

/**
 * Membuat promo platform baru. `is_public` bawaan `true`. Dicatat di log audit `promo.create`.
 * @param adminId id admin yang membuat
 * @param body    isi permintaan: kode dan kolom promo
 * @returns promo baru
 * @throws 400 isian tidak valid, 409 kode sudah dipakai
 */
export async function createPromo(adminId: number, body: unknown) {
  // 1. Periksa isian, termasuk kode.
  const { code, data } = parsePromoInput(body, 0, true);
  const isPublic = parseIsPublic(body) ?? true;
  try {
    return await withTransaction(async (conn) => {
      // 2. Simpan promo baru tanpa toko (merchant_id NULL = promo platform).
      const [insertResult] = await conn.query<any>(
        "INSERT INTO promos (merchant_id, code, description, type, value, max_discount, min_subtotal, quota, per_user_limit, starts_at, ends_at, is_public) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          code,
          data.description,
          data.type,
          data.value,
          data.max_discount,
          data.min_subtotal,
          data.quota,
          data.per_user_limit,
          data.starts_at,
          data.ends_at,
          isPublic,
        ],
      );
      // 3. Baca ulang barisnya dan catat di log audit.
      const [row] = await conn.query<RowDataPacket[]>("SELECT * FROM promos WHERE id = ?", [insertResult.insertId]);
      await recordAudit(conn, {
        adminId,
        action: "promo.create",
        targetType: "promo",
        targetId: insertResult.insertId,
        after: withBooleanFlags(row[0]),
      });
      return withBooleanFlags(row[0]);
    });
  } catch (error) {
    // 4. Kode yang sudah dipakai ditolak indeks unik database (ER_DUP_ENTRY); diubah menjadi 409.
    if ((error as { code?: string })?.code === "ER_DUP_ENTRY") throw duplicateCodeError();
    throw error;
  }
}

// Kunci satu promo platform (promo toko tidak bisa dibuka lewat menu admin ini).
const lockPromo = (conn: Conn, idRaw: unknown) =>
  lockRow(conn, "promos", idRaw, { where: "merchant_id IS NULL", notFound: "Promo tidak ditemukan." });

/**
 * Mengubah sebagian isi promo platform (PATCH). Kolom yang tidak dikirim memakai nilai tersimpan, lalu hasil gabungan
 * diperiksa ulang seluruhnya. Kode dan status aktif tidak bisa diubah di sini. Bila tidak ada kolom yang berubah,
 * tidak ada yang ditulis dan tidak ada log; selain itu log audit `promo.update` memuat kolom yang berubah saja.
 * @param adminId id admin yang mengubah
 * @param idRaw   id promo dari URL
 * @param body    kolom yang diubah
 * @returns promo sesudah diubah
 * @throws 400 isian tidak valid (termasuk kuota di bawah pemakaian), 404 promo platform tidak ada
 */
export async function updatePromo(adminId: number, idRaw: unknown, body: unknown) {
  return withTransaction(async (conn) => {
    // 1. Kunci promo, lalu gabungkan nilai tersimpan dengan kolom yang dikirim.
    const before = await lockPromo(conn, idRaw);
    const patch = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const merged = {
      ...Object.fromEntries(
        PROMO_FIELDS.map((key) => [
          key,
          before[key] instanceof Date ? (before[key] as Date).toISOString() : before[key],
        ]),
      ),
      ...Object.fromEntries(PROMO_FIELDS.filter((key) => key in patch).map((key) => [key, patch[key]])),
    };
    // 2. Periksa ulang hasil gabungan, lalu cari kolom yang nilainya benar-benar berubah.
    const isPublic = parseIsPublic(patch);
    const data: Record<string, unknown> = {
      ...parsePromoInput(merged, before.used_count).data,
      ...(isPublic === undefined ? {} : { is_public: isPublic }),
    };
    const columns = [...PROMO_FIELDS, "is_public" as const].filter(
      (column) =>
        column in data &&
        comparableValue(data[column]) !==
          comparableValue(column === "is_public" ? Boolean(before[column]) : before[column]),
    );
    if (!columns.length) return withBooleanFlags(before);
    // 3. Simpan kolom yang berubah dan catat nilai lama/barunya di log audit.
    await conn.query(`UPDATE promos SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`, [
      ...columns.map((column) => data[column]),
      before.id,
    ]);
    const [after] = await conn.query<RowDataPacket[]>("SELECT * FROM promos WHERE id = ?", [before.id]);
    const pick = (row: Record<string, unknown>) => Object.fromEntries(columns.map((column) => [column, row[column]]));
    await recordAudit(conn, {
      adminId,
      action: "promo.update",
      targetType: "promo",
      targetId: before.id,
      before: pick(before),
      after: pick(after[0]),
    });
    return withBooleanFlags(after[0]);
  });
}

/**
 * Menyalakan atau mematikan promo platform. Bila sudah dalam keadaan tujuan, dijawab 200 tanpa perubahan dan tanpa log
 * (idempoten). Dicatat di log audit `promo.activate` / `promo.deactivate`.
 * @param adminId id admin yang mengubah
 * @param idRaw   id promo dari URL
 * @param active  `true` untuk menyalakan, `false` untuk mematikan
 * @returns promo sesudah diubah
 * @throws 404 promo platform tidak ada
 */
export async function setPromoActive(adminId: number, idRaw: unknown, active: boolean) {
  return withTransaction(async (conn) => {
    // 1. Kunci promo; sudah dalam keadaan tujuan berarti selesai tanpa log.
    const row = await lockPromo(conn, idRaw);
    if (Boolean(row.is_active) === active) return withBooleanFlags(row);
    // 2. Simpan dan catat di log audit.
    await conn.query("UPDATE promos SET is_active = ? WHERE id = ?", [active, row.id]);
    await recordAudit(conn, {
      adminId,
      action: `promo.${active ? "activate" : "deactivate"}`,
      targetType: "promo",
      targetId: row.id,
      before: { is_active: !active },
      after: { is_active: active },
    });
    return withBooleanFlags({ ...row, is_active: active } as RowDataPacket);
  });
}

// --- Biaya layanan (app_settings.service_fee): rupiah yang ditambahkan ke setiap pesanan untuk platform ---
const serviceFeeSchema = z.object({
  value: z
    .number({ error: "Biaya wajib diisi." })
    .int("Biaya harus bilangan bulat.")
    .min(0, "Biaya tidak boleh negatif.")
    .max(100000, "Biaya maksimal 100.000."),
});

/**
 * Membaca biaya layanan yang berlaku.
 * @param conn sambungan database; bawaan pool, atau sambungan transaksi bila dibaca di dalam transaksi
 * @returns biaya layanan dalam rupiah; 0 bila belum diatur atau isinya bukan angka
 */
export async function getServiceFee(conn: Pick<typeof db, "query"> = db): Promise<number> {
  const [rows] = await conn.query<RowDataPacket[]>(
    "SELECT setting_value FROM app_settings WHERE setting_key = 'service_fee'",
  );
  const fee = parseInt(rows[0]?.setting_value ?? "0", 10);
  return Number.isFinite(fee) ? fee : 0;
}

/**
 * Mengubah biaya layanan (khusus admin super). Bila nilainya sama, tidak ada perubahan dan tidak ada log. Dicatat di
 * log audit `settings.service_fee`.
 * @param adminId id admin super yang mengubah
 * @param body    isi permintaan `{ value }`: bilangan bulat 0–100.000
 * @returns `{ service_fee }` sesudah diubah
 * @throws 400 nilai tidak valid
 */
export async function updateServiceFee(adminId: number, body: unknown) {
  const { value } = parse(serviceFeeSchema, body, "value");
  return withTransaction(async (conn) => {
    // 1. Pastikan barisnya ada, lalu kunci supaya dua perubahan bersamaan antre.
    await conn.query("INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('service_fee', '0')");
    await conn.query("SELECT setting_key FROM app_settings WHERE setting_key = 'service_fee' FOR UPDATE");
    // 2. Nilai sama: selesai tanpa log. Selain itu simpan dan catat nilai lama/baru di log audit.
    const previous = await getServiceFee(conn);
    if (previous === value) return { service_fee: previous };
    await conn.query("UPDATE app_settings SET setting_value = ? WHERE setting_key = 'service_fee'", [String(value)]);
    await recordAudit(conn, {
      adminId,
      action: "settings.service_fee",
      targetType: "settings",
      targetId: "service_fee",
      before: { value: previous },
      after: { value },
    });
    return { service_fee: value };
  });
}

// --- Kontak CS (app_settings.cs_whatsapp): nomor WhatsApp layanan pelanggan; teks kosong = belum diatur ---
/**
 * Membaca nomor WhatsApp CS.
 * @returns nomor WA, atau null bila belum diatur
 */
export async function getCsContact(): Promise<string | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT setting_value FROM app_settings WHERE setting_key = 'cs_whatsapp'",
  );
  return rows[0]?.setting_value || null;
}

/**
 * Mengubah atau mengosongkan nomor WhatsApp CS (khusus admin super). Bila nilainya sama, tidak ada perubahan dan tidak
 * ada log. Dicatat di log audit `settings.cs_whatsapp`.
 * @param adminId  id admin super yang mengubah
 * @param waNumber nomor WA 08… yang sudah diperiksa csContactSchema, atau teks kosong untuk mengosongkan
 * @returns `{ cs_whatsapp }` sesudah diubah (null bila kosong)
 */
export async function updateCsContact(adminId: number, waNumber: string) {
  return withTransaction(async (conn) => {
    // 1. Pastikan barisnya ada, lalu kunci dan baca nilai lama.
    await conn.query("INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('cs_whatsapp', '')");
    const [[row]] = await conn.query<RowDataPacket[]>(
      "SELECT setting_value FROM app_settings WHERE setting_key = 'cs_whatsapp' FOR UPDATE",
    );
    // 2. Nilai sama: selesai tanpa log. Selain itu simpan dan catat nilai lama/baru di log audit.
    const previous = row.setting_value || null;
    const updated = waNumber || null;
    if (previous === updated) return { cs_whatsapp: previous };
    await conn.query("UPDATE app_settings SET setting_value = ? WHERE setting_key = 'cs_whatsapp'", [waNumber]);
    await recordAudit(conn, {
      adminId,
      action: "settings.cs_whatsapp",
      targetType: "settings",
      targetId: "cs_whatsapp",
      before: { value: previous },
      after: { value: updated },
    });
    return { cs_whatsapp: updated };
  });
}
