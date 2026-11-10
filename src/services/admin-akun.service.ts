import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { AdminLevel } from "../middleware/auth";
import { AppError } from "../utils/errors";
import { catat, Conn, dalamTransaksi, kunci } from "./admin-audit.service";
import { insertUser } from "./auth.service";

export const ADMIN_LEVELS = ["super", "ops", "support"] as const;

// Sandi sementara 14 karakter; akhiran "a7" menjamin aturan sandi (huruf + angka) selalu terpenuhi.
export const sandiSementara = () => crypto.randomBytes(9).toString("base64url").replace(/[-_]/g, "x") + "a7";

const PILIH = `SELECT u.id, u.full_name, u.phone, u.email, u.admin_level, u.is_active, u.must_change_password, u.created_at,
  (SELECT MAX(s.created_at) FROM auth_sessions s WHERE s.user_id = u.id) AS last_login_at
  FROM users u WHERE u.role = 'admin'`;
const peta = (r: RowDataPacket) => ({ ...r, is_active: Boolean(r.is_active), must_change_password: Boolean(r.must_change_password) });

export async function daftarAdmin() {
  const [rows] = await db.query<RowDataPacket[]>(`${PILIH} ORDER BY u.is_active DESC, u.id`);
  return rows.map(peta);
}

const satu = async (conn: Conn, id: number) => {
  const [rows] = await conn.query<RowDataPacket[]>(`${PILIH} AND u.id = ?`, [id]);
  return peta(rows[0]);
};

const dupe = (e: unknown): never => {
  if ((e as { code?: string })?.code === "ER_DUP_ENTRY") {
    throw new AppError(409, "CONFLICT", "Nomor sudah terdaftar.", { phone: ["Nomor sudah terdaftar."] });
  }
  throw e;
};

// Dipakai juga oleh CLI admin:create (bootstrap, level super, sandi dari env).
export async function simpanAdmin(conn: Conn, input: { full_name: string; phone: string; password: string }, level: AdminLevel, wajibGanti: boolean) {
  const user = await insertUser(conn, "admin", input).catch(dupe);
  await conn.query("UPDATE users SET admin_level = ?, must_change_password = ? WHERE id = ?", [level, wajibGanti, user.id]);
  return user.id;
}

// Sandi sementara dikembalikan sekali di respons ini dan tidak disimpan dalam bentuk asli.
export async function buatAdmin(actorId: number, input: { full_name: string; phone: string; admin_level: AdminLevel }) {
  const password = sandiSementara();
  return dalamTransaksi(async (conn) => {
    const id = await simpanAdmin(conn, { full_name: input.full_name, phone: input.phone, password }, input.admin_level, true);
    const after = await satu(conn, id);
    await catat(conn, { adminId: actorId, action: "admin.create", targetType: "admin", targetId: id, after });
    return { admin: after, temp_password: password };
  });
}

// Kunci semua super aktif agar dua permintaan bersamaan tidak sama-sama menurunkan super terakhir.
const jagaSuperTerakhir = async (conn: Conn, target: RowDataPacket) => {
  if (target.admin_level !== "super" || !target.is_active) return;
  const [rows] = await conn.query<RowDataPacket[]>(
    "SELECT id FROM users WHERE role = 'admin' AND admin_level = 'super' AND is_active = TRUE FOR UPDATE",
  );
  if (rows.length <= 1) throw new AppError(409, "CONFLICT", "Harus ada minimal satu admin super yang aktif.");
};

const ubah = (actorId: number, idRaw: unknown, action: string, fn: (conn: Conn, target: RowDataPacket) => Promise<void>, reason?: string) =>
  dalamTransaksi(async (conn) => {
    const target = await kunci(conn, "users", idRaw, { where: "role = 'admin'", notFound: "Admin tidak ditemukan." });
    if (target.id === actorId) throw new AppError(409, "CONFLICT", "Tidak bisa mengubah akun sendiri di sini.");
    const before = await satu(conn, target.id);
    await fn(conn, target);
    const after = await satu(conn, target.id);
    await catat(conn, { adminId: actorId, action, targetType: "admin", targetId: target.id, reason, before, after });
    return after;
  });

export const ubahLevel = (actorId: number, id: unknown, level: AdminLevel) =>
  ubah(actorId, id, "admin.level", async (conn, t) => {
    if (level !== "super") await jagaSuperTerakhir(conn, t);
    await conn.query("UPDATE users SET admin_level = ? WHERE id = ?", [level, t.id]);
  });

export const setAktifAdmin = (actorId: number, id: unknown, aktif: boolean) =>
  ubah(actorId, id, aktif ? "admin.activate" : "admin.deactivate", async (conn, t) => {
    if (!aktif) await jagaSuperTerakhir(conn, t);
    await conn.query("UPDATE users SET is_active = ? WHERE id = ?", [aktif, t.id]);
    // bacaSesi sudah menolak user nonaktif; sesi tetap dicabut agar tidak hidup lagi saat diaktifkan ulang
    if (!aktif) await conn.query("UPDATE auth_sessions SET revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND revoked_at IS NULL", [t.id]);
  });

// Admin lupa sandi: sandi sementara baru, semua sesinya dicabut, wajib ganti saat masuk.
export async function resetSandiAdmin(actorId: number, id: unknown) {
  const password = sandiSementara();
  const hash = await bcrypt.hash(password, 10);
  const admin = await ubah(actorId, id, "admin.reset-password", async (conn, t) => {
    await conn.query("UPDATE users SET password_hash = ?, must_change_password = TRUE WHERE id = ?", [hash, t.id]);
    await conn.query("UPDATE auth_sessions SET revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND revoked_at IS NULL", [t.id]);
  });
  return { admin, temp_password: password };
}
