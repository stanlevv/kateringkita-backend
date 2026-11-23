import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { AdminLevel } from "../middleware/auth";
import { AppError } from "../utils/errors";
import { recordAudit, Conn, withTransaction, lockRow } from "./admin-audit.service";
import { insertUser } from "./auth.service";

export const ADMIN_LEVELS = ["super", "ops", "support"] as const;

// Sandi sementara 14 karakter; akhiran "a7" menjamin aturan sandi (huruf + angka) selalu terpenuhi.
export const generateTempPassword = () => crypto.randomBytes(9).toString("base64url").replace(/[-_]/g, "x") + "a7";

const ADMIN_SELECT_SQL = `SELECT u.id, u.full_name, u.phone, u.email, u.admin_level, u.is_active, u.must_change_password, u.created_at,
  (SELECT MAX(s.created_at) FROM auth_sessions s WHERE s.user_id = u.id) AS last_login_at
  FROM users u WHERE u.role = 'admin'`;
const mapAdmin = (row: RowDataPacket) => ({
  ...row,
  is_active: Boolean(row.is_active),
  must_change_password: Boolean(row.must_change_password),
});

export async function listAdmins() {
  const [rows] = await db.query<RowDataPacket[]>(`${ADMIN_SELECT_SQL} ORDER BY u.is_active DESC, u.id`);
  return rows.map(mapAdmin);
}

const loadAdmin = async (conn: Conn, id: number) => {
  const [rows] = await conn.query<RowDataPacket[]>(`${ADMIN_SELECT_SQL} AND u.id = ?`, [id]);
  return mapAdmin(rows[0]);
};

const rethrowDuplicatePhone = (error: unknown): never => {
  if ((error as { code?: string })?.code === "ER_DUP_ENTRY") {
    throw new AppError(409, "CONFLICT", "Nomor sudah terdaftar.", { phone: ["Nomor sudah terdaftar."] });
  }
  throw error;
};

// Dipakai juga oleh CLI admin:create (bootstrap, level super, sandi dari env).
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

// Sandi sementara dikembalikan sekali di respons ini dan tidak disimpan dalam bentuk asli.
export async function createAdmin(
  actorId: number,
  input: { full_name: string; phone: string; admin_level: AdminLevel },
) {
  const password = generateTempPassword();
  return withTransaction(async (conn) => {
    const id = await saveAdmin(
      conn,
      { full_name: input.full_name, phone: input.phone, password },
      input.admin_level,
      true,
    );
    const after = await loadAdmin(conn, id);
    await recordAudit(conn, { adminId: actorId, action: "admin.create", targetType: "admin", targetId: id, after });
    return { admin: after, temp_password: password };
  });
}

// Kunci semua super aktif agar dua permintaan bersamaan tidak sama-sama menurunkan super terakhir.
const guardLastSuperAdmin = async (conn: Conn, target: RowDataPacket) => {
  if (target.admin_level !== "super" || !target.is_active) return;
  const [rows] = await conn.query<RowDataPacket[]>(
    "SELECT id FROM users WHERE role = 'admin' AND admin_level = 'super' AND is_active = TRUE FOR UPDATE",
  );
  if (rows.length <= 1) throw new AppError(409, "CONFLICT", "Harus ada minimal satu admin super yang aktif.");
};

const updateAdmin = (
  actorId: number,
  idRaw: unknown,
  action: string,
  change: (conn: Conn, target: RowDataPacket) => Promise<void>,
  reason?: string,
) =>
  withTransaction(async (conn) => {
    const target = await lockRow(conn, "users", idRaw, { where: "role = 'admin'", notFound: "Admin tidak ditemukan." });
    if (target.id === actorId) throw new AppError(409, "CONFLICT", "Tidak bisa mengubah akun sendiri di sini.");
    const before = await loadAdmin(conn, target.id);
    await change(conn, target);
    const after = await loadAdmin(conn, target.id);
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

export const updateAdminLevel = (actorId: number, id: unknown, level: AdminLevel) =>
  updateAdmin(actorId, id, "admin.level", async (conn, target) => {
    if (level !== "super") await guardLastSuperAdmin(conn, target);
    await conn.query("UPDATE users SET admin_level = ? WHERE id = ?", [level, target.id]);
  });

export const setAdminActive = (actorId: number, id: unknown, active: boolean) =>
  updateAdmin(actorId, id, active ? "admin.activate" : "admin.deactivate", async (conn, target) => {
    if (!active) await guardLastSuperAdmin(conn, target);
    await conn.query("UPDATE users SET is_active = ? WHERE id = ?", [active, target.id]);
    // getSession sudah menolak user nonaktif; sesi tetap dicabut agar tidak hidup lagi saat diaktifkan ulang
    if (!active)
      await conn.query(
        "UPDATE auth_sessions SET revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND revoked_at IS NULL",
        [target.id],
      );
  });

// Admin lupa sandi: sandi sementara baru, semua sesinya dicabut, wajib ganti saat masuk.
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
