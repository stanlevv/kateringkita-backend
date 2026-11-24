// Isi file: kelola akun admin di panel admin (GET/POST /admin/admins dan aksinya), yaitu daftar admin, buat admin
// baru, ubah tingkat, aktif/nonaktifkan, dan reset sandi. Alurnya routes/admin.ts → handlers/admin.handler.ts → file
// ini → database. Semua rute /admin/admins hanya untuk admin super (dijaga middleware/admin-access.ts).
//
// Tingkat admin: `super` boleh semua fitur termasuk kelola admin, AI, keuangan, pencairan, refund, dan server;
// `ops` boleh semua fitur lain (verifikasi penjual, moderasi, promo, data master, dan lainnya); `support` hanya boleh
// melihat (GET) ditambah membalas dan menutup tiket bantuan. Setiap perubahan akun admin dicatat di log audit.
// Sandi sementara: sandi acak yang dibuat server untuk admin baru atau admin yang direset; admin wajib menggantinya
// saat pertama masuk.
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { AdminLevel } from "../middleware/auth";
import { AppError } from "../utils/errors";
import { recordAudit, Conn, withTransaction, lockRow } from "./admin-audit.service";
import { insertUser } from "./auth.service";

/** Tiga tingkat admin yang dikenal, dari akses terluas: super, ops, support. */
export const ADMIN_LEVELS = ["super", "ops", "support"] as const;

/**
 * Membuat sandi sementara acak 14 karakter. Akhiran "a7" menjamin aturan sandi (ada huruf dan angka) selalu terpenuhi.
 * @returns sandi sementara dalam bentuk asli (belum di-hash)
 */
export const generateTempPassword = () => crypto.randomBytes(9).toString("base64url").replace(/[-_]/g, "x") + "a7";

// Kolom akun admin yang boleh dikirim ke panel (tanpa hash sandi) dan waktu login terakhir dari tabel sesi.
const ADMIN_SELECT_SQL = `SELECT u.id, u.full_name, u.phone, u.email, u.admin_level, u.is_active, u.must_change_password, u.created_at,
  (SELECT MAX(s.created_at) FROM auth_sessions s WHERE s.user_id = u.id) AS last_login_at
  FROM users u WHERE u.role = 'admin'`;
// Kolom 0/1 MySQL menjadi true/false.
const mapAdmin = (row: RowDataPacket) => ({
  ...row,
  is_active: Boolean(row.is_active),
  must_change_password: Boolean(row.must_change_password),
});

/**
 * Daftar semua akun admin: yang aktif dulu, lalu urut id.
 * @returns daftar admin beserta tingkat, status aktif, wajib ganti sandi, dan waktu login terakhir
 */
export async function listAdmins() {
  const [rows] = await db.query<RowDataPacket[]>(`${ADMIN_SELECT_SQL} ORDER BY u.is_active DESC, u.id`);
  return rows.map(mapAdmin);
}

// Membaca satu akun admin lewat sambungan transaksi (untuk isi sebelum/sesudah di log audit).
const loadAdmin = async (conn: Conn, id: number) => {
  const [rows] = await conn.query<RowDataPacket[]>(`${ADMIN_SELECT_SQL} AND u.id = ?`, [id]);
  return mapAdmin(rows[0]);
};

// Galat MySQL "nilai kembar" pada nomor HP diubah menjadi 409 dengan pesan per kolom; galat lain diteruskan.
const rethrowDuplicatePhone = (error: unknown): never => {
  if ((error as { code?: string })?.code === "ER_DUP_ENTRY") {
    throw new AppError(409, "CONFLICT", "Nomor sudah terdaftar.", { phone: ["Nomor sudah terdaftar."] });
  }
  throw error;
};

/**
 * Menyimpan akun admin baru lalu mengatur tingkat dan tanda wajib ganti sandi. Dipakai juga skrip
 * `npm run admin:create` untuk membuat admin super pertama dengan sandi dari env.
 * @param conn               sambungan transaksi
 * @param input              nama lengkap, nomor HP, dan sandi asli (di-hash di insertUser)
 * @param level              tingkat admin
 * @param mustChangePassword `true` bila admin wajib mengganti sandi saat pertama masuk
 * @returns id akun admin baru
 * @throws 409 bila nomor HP sudah terdaftar
 */
export async function saveAdmin(
  conn: Conn,
  input: { full_name: string; phone: string; password: string },
  level: AdminLevel,
  mustChangePassword: boolean,
) {
  const user = await insertUser(conn, "admin", input).catch(rethrowDuplicatePhone);
  await conn.query("UPDATE users SET admin_level = ?, must_change_password = ? WHERE id = ?", [
    level,
    mustChangePassword,
    user.id,
  ]);
  return user.id;
}

/**
 * Admin super membuat akun admin baru dengan sandi sementara. Sandi itu dikirim sekali di respons ini saja; database
 * hanya menyimpan hash-nya. Pembuatan dicatat di log audit (`admin.create`).
 * @param actorId id admin super yang membuat
 * @param input   nama lengkap, nomor HP, dan tingkat admin baru
 * @returns `{ admin, temp_password }`
 * @throws 409 bila nomor HP sudah terdaftar
 */
export async function createAdmin(
  actorId: number,
  input: { full_name: string; phone: string; admin_level: AdminLevel },
) {
  // 1. Buat sandi sementara di luar transaksi.
  const password = generateTempPassword();
  return withTransaction(async (conn) => {
    // 2. Simpan akun baru dengan tanda wajib ganti sandi.
    const id = await saveAdmin(
      conn,
      { full_name: input.full_name, phone: input.phone, password },
      input.admin_level,
      true,
    );
    // 3. Catat pembuatan di log audit, lalu kirim akun beserta sandi sementaranya.
    const after = await loadAdmin(conn, id);
    await recordAudit(conn, { adminId: actorId, action: "admin.create", targetType: "admin", targetId: id, after });
    return { admin: after, temp_password: password };
  });
}

// Menolak bila admin yang akan diturunkan atau dinonaktifkan adalah satu-satunya super aktif. Semua super aktif
// dikunci dulu supaya dua permintaan bersamaan tidak sama-sama lolos lalu menghabiskan super terakhir.
const guardLastSuperAdmin = async (conn: Conn, target: RowDataPacket) => {
  if (target.admin_level !== "super" || !target.is_active) return;
  const [rows] = await conn.query<RowDataPacket[]>(
    "SELECT id FROM users WHERE role = 'admin' AND admin_level = 'super' AND is_active = TRUE FOR UPDATE",
  );
  if (rows.length <= 1) throw new AppError(409, "CONFLICT", "Harus ada minimal satu admin super yang aktif.");
};

// Kerangka bersama untuk mengubah akun admin lain di dalam satu transaksi: kunci akun target, tolak bila target adalah
// akun sendiri, jalankan perubahan, lalu catat isi sebelum dan sesudah di log audit.
const updateAdmin = (
  actorId: number,
  idRaw: unknown,
  action: string,
  change: (conn: Conn, target: RowDataPacket) => Promise<void>,
  reason?: string,
) =>
  withTransaction(async (conn) => {
    // 1. Kunci akun admin target; akun sendiri tidak bisa diubah lewat menu ini.
    const target = await lockRow(conn, "users", idRaw, { where: "role = 'admin'", notFound: "Admin tidak ditemukan." });
    if (target.id === actorId) throw new AppError(409, "CONFLICT", "Tidak bisa mengubah akun sendiri di sini.");
    // 2. Simpan isi sebelum, jalankan perubahan, lalu baca isi sesudah.
    const before = await loadAdmin(conn, target.id);
    await change(conn, target);
    const after = await loadAdmin(conn, target.id);
    // 3. Catat di log audit dengan nama aksi dari pemanggil.
    await recordAudit(conn, {
      adminId: actorId,
      action,
      targetType: "admin",
      targetId: target.id,
      reason,
      before,
      after,
    });
    return after;
  });

/**
 * Mengubah tingkat admin lain (`admin.level` di log audit).
 * @param actorId id admin super yang mengubah
 * @param id      id admin target dari URL
 * @param level   tingkat baru
 * @returns akun admin sesudah diubah
 * @throws 404 admin tidak ada, 409 target adalah akun sendiri atau satu-satunya super aktif yang akan diturunkan
 */
export const updateAdminLevel = (actorId: number, id: unknown, level: AdminLevel) =>
  updateAdmin(actorId, id, "admin.level", async (conn, target) => {
    if (level !== "super") await guardLastSuperAdmin(conn, target);
    await conn.query("UPDATE users SET admin_level = ? WHERE id = ?", [level, target.id]);
  });

/**
 * Mengaktifkan atau menonaktifkan admin lain (`admin.activate` / `admin.deactivate` di log audit). Saat dinonaktifkan,
 * semua sesi loginnya dicabut.
 * @param actorId id admin super yang mengubah
 * @param id      id admin target dari URL
 * @param active  `true` untuk mengaktifkan, `false` untuk menonaktifkan
 * @returns akun admin sesudah diubah
 * @throws 404 admin tidak ada, 409 target adalah akun sendiri atau satu-satunya super aktif yang akan dinonaktifkan
 */
export const setAdminActive = (actorId: number, id: unknown, active: boolean) =>
  updateAdmin(actorId, id, active ? "admin.activate" : "admin.deactivate", async (conn, target) => {
    if (!active) await guardLastSuperAdmin(conn, target);
    await conn.query("UPDATE users SET is_active = ? WHERE id = ?", [active, target.id]);
    // Cek sesi login sudah menolak akun nonaktif; sesi tetap dicabut supaya tidak hidup lagi saat diaktifkan ulang.
    if (!active)
      await conn.query(
        "UPDATE auth_sessions SET revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND revoked_at IS NULL",
        [target.id],
      );
  });

/**
 * Mereset sandi admin lain yang lupa sandi: sandi sementara baru, semua sesi loginnya dicabut, dan ia wajib mengganti
 * sandi saat masuk. Dicatat di log audit (`admin.reset-password`) tanpa menyimpan sandinya.
 * @param actorId id admin super yang mereset
 * @param id      id admin target dari URL
 * @returns `{ admin, temp_password }`; sandi sementara hanya dikirim sekali di respons ini
 * @throws 404 admin tidak ada, 409 target adalah akun sendiri
 */
export async function resetAdminPassword(actorId: number, id: unknown) {
  const password = generateTempPassword();
  const hash = await bcrypt.hash(password, 10);
  const admin = await updateAdmin(actorId, id, "admin.reset-password", async (conn, target) => {
    await conn.query("UPDATE users SET password_hash = ?, must_change_password = TRUE WHERE id = ?", [hash, target.id]);
    await conn.query("UPDATE auth_sessions SET revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND revoked_at IS NULL", [
      target.id,
    ]);
  });
  return { admin, temp_password: password };
}
