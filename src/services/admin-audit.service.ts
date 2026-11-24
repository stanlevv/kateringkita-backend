// Isi file: alat bersama untuk menulis ke database dengan aman, yaitu transaksi, kunci baris, dan log audit admin,
// ditambah daftar log audit untuk panel admin (GET /admin/audit-logs). Hampir semua service yang mengubah data
// memakai withTransaction dari sini; alurnya routes → handlers → services (file ini dipanggil dari dalamnya)
// → database.
//
// Istilah:
// - Transaksi DB: sekumpulan perintah SQL yang dianggap satu paket. Bila semua berhasil, hasilnya disimpan (commit);
//   bila satu gagal, semua perubahan di paket itu dibatalkan (rollback), jadi data tidak pernah setengah jadi.
// - Kunci baris (FOR UPDATE): baris yang sedang diubah dikunci sampai transaksi selesai, sehingga permintaan lain yang
//   mau mengubah baris yang sama harus menunggu giliran.
// - Log audit: catatan setiap perubahan yang dilakukan admin (siapa, aksi apa, terhadap data apa, alasan, serta isi
//   sebelum dan sesudah), disimpan di tabel admin_audit_logs supaya tindakan admin bisa ditelusuri.
import { RowDataPacket } from "mysql2";
import { PoolConnection } from "mysql2/promise";
import db from "../config/db";
import { AppError } from "../utils/errors";

/**
 * Satu baris log audit: admin pelaku, nama aksi (contoh `merchant.verify`), jenis dan id data, alasan, serta isi
 * sebelum dan sesudah.
 */
export type AuditEntry = {
  adminId: number;
  action: string;
  targetType: string;
  targetId: string | number;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
};

// Isi sebelum/sesudah disimpan sebagai teks JSON; bila tidak diisi, kolomnya NULL.
const toJsonOrNull = (value: unknown) => (value === undefined ? null : JSON.stringify(value));

/**
 * Menulis satu baris log audit admin. Harus dipanggil dengan sambungan transaksi yang sama dengan perubahan datanya,
 * supaya perubahan dan catatannya selalu tersimpan bersama atau batal bersama.
 * @param conn  sambungan database (biasanya sambungan transaksi dari withTransaction)
 * @param entry isi catatan: admin, aksi, jenis dan id data, alasan, isi sebelum dan sesudah
 * @returns selesai setelah baris log tersimpan
 */
export async function recordAudit(conn: Pick<PoolConnection, "query">, entry: AuditEntry): Promise<void> {
  // 1. Satu INSERT; id data disimpan sebagai teks supaya id angka dan kode (contoh kode tiket) muat di kolom yang sama.
  await conn.query(
    "INSERT INTO admin_audit_logs (admin_user_id, action, target_type, target_id, reason, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      entry.adminId,
      entry.action,
      entry.targetType,
      String(entry.targetId),
      entry.reason ?? null,
      toJsonOrNull(entry.before),
      toJsonOrNull(entry.after),
    ],
  );
}

/**
 * Menjalankan pekerjaan di dalam satu transaksi: disimpan (commit) bila pekerjaan selesai, dibatalkan (rollback) bila
 * pekerjaan melempar galat. Sambungan selalu dikembalikan ke pool di akhir.
 * @param work           fungsi berisi perintah SQL; menerima sambungan transaksi dan mengembalikan hasilnya
 * @param isolationLevel tingkat isolasi khusus untuk transaksi ini saja; `READ COMMITTED` membuat setiap pembacaan
 *                       melihat data terbaru yang sudah disimpan transaksi lain
 * @returns hasil dari `work`
 * @throws galat apa pun yang dilempar `work`, setelah semua perubahannya dibatalkan
 */
export async function withTransaction<T>(
  work: (conn: PoolConnection) => Promise<T>,
  isolationLevel?: "READ COMMITTED",
): Promise<T> {
  // 1. Pinjam satu sambungan dari pool; semua perintah transaksi harus lewat sambungan yang sama.
  const conn = await db.getConnection();
  try {
    // 2. Atur tingkat isolasi (bila diminta), mulai transaksi, jalankan pekerjaan, lalu simpan.
    if (isolationLevel) await conn.query(`SET TRANSACTION ISOLATION LEVEL ${isolationLevel}`);
    await conn.beginTransaction();
    const result = await work(conn);
    await conn.commit();
    return result;
  } catch (error) {
    // 3. Ada yang gagal: batalkan semua perubahan, lalu teruskan galatnya.
    await conn.rollback();
    throw error;
  } finally {
    // 4. Kembalikan sambungan ke pool, berhasil atau gagal.
    conn.release();
  }
}

/** Sambungan database yang dipakai di dalam transaksi (singkatan tipe dari mysql2). */
export type Conn = PoolConnection;

/**
 * Mengubah kolom `is_active` (dan `is_public` bila ada) dari angka 0/1 MySQL menjadi `true`/`false`. `is_public`
 * hanya ada di baris tabel promos; baris tabel lain tidak diberi kolom itu.
 * @param row satu baris hasil query
 * @returns salinan baris dengan kolom tersebut berupa boolean
 */
export const withBooleanFlags = (row: RowDataPacket) => ({
  ...row,
  is_active: Boolean(row.is_active),
  ...("is_public" in row ? { is_public: Boolean(row.is_public) } : {}),
});

/**
 * Mengambil dan mengunci satu baris (FOR UPDATE) di dalam transaksi, supaya tidak diubah permintaan lain sampai
 * transaksi selesai. Id yang bukan bilangan bulat positif langsung dianggap tidak ada, tanpa bertanya ke database.
 * @param conn    sambungan transaksi
 * @param table   nama tabel (selalu ditulis di kode, bukan dari input pengguna)
 * @param idRaw   id baris dari URL, belum diperiksa
 * @param options `where` = syarat tambahan SQL (contoh `deleted_at IS NULL`), `notFound` = pesan bila tidak ada
 * @returns baris yang sudah terkunci
 * @throws 404 bila id tidak valid, baris tidak ada, atau tidak memenuhi syarat tambahan
 */
export async function lockRow(
  conn: Conn,
  table: string,
  idRaw: unknown,
  options: { where?: string; notFound?: string } = {},
) {
  const id = Number(idRaw);
  const [rows] =
    Number.isInteger(id) && id > 0
      ? await conn.query<RowDataPacket[]>(
          `SELECT * FROM ${table} WHERE id = ?${options.where ? ` AND ${options.where}` : ""} FOR UPDATE`,
          [id],
        )
      : [[]];
  if (!rows[0]) throw new AppError(404, "NOT_FOUND", options.notFound ?? "Data tidak ditemukan.");
  return rows[0];
}

/**
 * Filter daftar log audit yang sudah diperiksa: halaman, jumlah per halaman, admin pelaku, aksi, jenis dan id data,
 * serta rentang waktu `[from, to)` dalam UTC.
 */
export type LogFilter = {
  page: number;
  limit: number;
  admin?: number;
  action?: string;
  targetType?: string;
  targetId?: string;
  from?: Date;
  to?: Date;
};

// Melempar 400 dengan pesan galat untuk satu kolom filter.
const invalidFilter = (field: string, message: string): never => {
  throw new AppError(400, "VALIDATION_ERROR", "Filter tidak valid.", { [field]: [message] });
};
// Tanggal "YYYY-MM-DD" (tanggal WIB) menjadi waktu awal hari itu dalam UTC (WIB = UTC+7, jadi mundur 7 jam).
const parseWibDate = (field: string, value: string): Date => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const date = match ? new Date(Date.UTC(+match[1], +match[2] - 1, +match[3])) : null;
  if (!match || !date || date.getUTCMonth() !== +match[2] - 1)
    return invalidFilter(field, "Tanggal harus berformat TTTT-BB-HH.");
  return new Date(date.getTime() - 7 * 3600e3);
};

/**
 * Mengubah query string mentah `GET /admin/audit-logs` menjadi filter yang sudah diperiksa.
 * @param query query string: `action`, `target_type`, `target_id`, `admin` (id admin), `from`, `to` (tanggal WIB)
 * @param page  nomor halaman yang sudah dirapikan handler
 * @param limit jumlah baris per halaman yang sudah dirapikan handler
 * @returns filter siap pakai; `to` digeser ke awal hari berikutnya supaya seluruh hari `to` ikut
 * @throws 400 bila teks terlalu panjang, id admin bukan angka, atau tanggal tidak berformat TTTT-BB-HH
 */
export function parseLogFilter(query: Record<string, unknown>, page: number, limit: number): LogFilter {
  // 1. Pembaca teks: kosong dianggap tidak diisi, terlalu panjang atau bukan teks ditolak.
  const readString = (key: string, max: number) => {
    const value = query[key];
    if (value === undefined || value === "") return undefined;
    if (typeof value !== "string" || value.length > max) return invalidFilter(key, `Maksimal ${max} karakter.`);
    return value;
  };
  // 2. Filter teks biasa.
  const filter: LogFilter = {
    page,
    limit,
    action: readString("action", 60),
    targetType: readString("target_type", 30),
    targetId: readString("target_id", 40),
  };
  // 3. Id admin harus bilangan bulat positif.
  const admin = readString("admin", 10);
  if (admin !== undefined) {
    if (!/^[1-9]\d*$/.test(admin)) invalidFilter("admin", "Admin tidak valid.");
    filter.admin = Number(admin);
  }
  // 4. Rentang tanggal WIB menjadi waktu UTC.
  const from = readString("from", 10);
  const to = readString("to", 10);
  if (from) filter.from = parseWibDate("from", from);
  if (to) filter.to = new Date(parseWibDate("to", to).getTime() + 86400e3); // batas atas eksklusif
  return filter;
}

/**
 * Daftar log audit admin per halaman, terbaru dulu, beserta nama admin pelakunya.
 * @param filter filter dari parseLogFilter (halaman, admin, aksi, jenis dan id data, rentang waktu)
 * @returns `{ data, meta: { page, limit, total } }`; isi sebelum/sesudah dikirim di kunci `before` dan `after`
 */
export async function listAuditLogs({ page, limit, admin, action, targetType, targetId, from, to }: LogFilter) {
  // 1. Susun syarat WHERE hanya dari filter yang diisi.
  const where: string[] = [];
  const args: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    if (value !== undefined) {
      where.push(sql);
      args.push(value);
    }
  };
  add("l.admin_user_id = ?", admin);
  add("l.action = ?", action);
  add("l.target_type = ?", targetType);
  add("l.target_id = ?", targetId);
  add("l.created_at >= ?", from);
  add("l.created_at < ?", to);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  // 2. Ambil satu halaman log, lalu hitung total baris dengan syarat yang sama.
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT l.id, l.admin_user_id, u.full_name AS admin_name, l.action, l.target_type, l.target_id, l.reason,
            l.before_json AS \`before\`, l.after_json AS \`after\`, l.created_at
     FROM admin_audit_logs l JOIN users u ON u.id = l.admin_user_id
     ${whereSql} ORDER BY l.id DESC LIMIT ? OFFSET ?`,
    [...args, limit, (page - 1) * limit],
  );
  const [counts] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total FROM admin_audit_logs l ${whereSql}`,
    args,
  );
  return { data: rows, meta: { page, limit, total: Number(counts[0].total) } };
}
