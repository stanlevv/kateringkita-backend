import { RowDataPacket } from "mysql2";
import { PoolConnection } from "mysql2/promise";
import db from "../config/db";
import { AppError } from "../http/errors";

export type AuditEntry = {
  adminId: number;
  action: string;
  targetType: string;
  targetId: string | number;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
};

const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));

// Dipanggil di dalam transaksi yang sama dengan perubahannya.
export async function catat(conn: Pick<PoolConnection, "query">, e: AuditEntry): Promise<void> {
  await conn.query(
    "INSERT INTO admin_audit_logs (admin_user_id, action, target_type, target_id, reason, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [e.adminId, e.action, e.targetType, String(e.targetId), e.reason ?? null, json(e.before), json(e.after)],
  );
}

// Satu transaksi: commit bila fn selesai, rollback bila melempar. `isolasi` hanya berlaku untuk transaksi ini.
export async function dalamTransaksi<T>(fn: (conn: PoolConnection) => Promise<T>, isolasi?: "READ COMMITTED"): Promise<T> {
  const conn = await db.getConnection();
  try {
    if (isolasi) await conn.query(`SET TRANSACTION ISOLATION LEVEL ${isolasi}`);
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

export type Conn = PoolConnection;

export const withBool = (r: RowDataPacket) => ({ ...r, is_active: Boolean(r.is_active) });

// Kunci satu baris (FOR UPDATE) di dalam transaksi; id tak valid atau tak ada -> 404.
export async function kunci(conn: Conn, table: string, idRaw: unknown, o: { where?: string; notFound?: string } = {}) {
  const id = Number(idRaw);
  const [rows] = Number.isInteger(id) && id > 0
    ? await conn.query<RowDataPacket[]>(`SELECT * FROM ${table} WHERE id = ?${o.where ? ` AND ${o.where}` : ""} FOR UPDATE`, [id])
    : [[]];
  if (!rows[0]) throw new AppError(404, "NOT_FOUND", o.notFound ?? "Data tidak ditemukan.");
  return rows[0];
}

export type LogFilter = {
  page: number; limit: number; admin?: number; action?: string; targetType?: string; targetId?: string; from?: Date; to?: Date;
};

const salah = (field: string, msg: string): never => {
  throw new AppError(400, "VALIDATION_ERROR", "Filter tidak valid.", { [field]: [msg] });
};
// "YYYY-MM-DD" (tanggal WIB) -> awal hari WIB dalam UTC
const tanggalWib = (field: string, v: string): Date => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
  if (!m || !d || d.getUTCMonth() !== +m[2] - 1) return salah(field, "Tanggal harus berformat TTTT-BB-HH.");
  return new Date(d.getTime() - 7 * 3600e3);
};

// Query string mentah -> filter tervalidasi (nilai tak valid -> 400).
export function filterLog(q: Record<string, unknown>, page: number, limit: number): LogFilter {
  const s = (k: string, max: number) => {
    const v = q[k];
    if (v === undefined || v === "") return undefined;
    if (typeof v !== "string" || v.length > max) return salah(k, `Maksimal ${max} karakter.`);
    return v;
  };
  const f: LogFilter = { page, limit, action: s("action", 60), targetType: s("target_type", 30), targetId: s("target_id", 40) };
  const admin = s("admin", 10);
  if (admin !== undefined) {
    if (!/^[1-9]\d*$/.test(admin)) salah("admin", "Admin tidak valid.");
    f.admin = Number(admin);
  }
  const from = s("from", 10);
  const to = s("to", 10);
  if (from) f.from = tanggalWib("from", from);
  if (to) f.to = new Date(tanggalWib("to", to).getTime() + 86400e3); // batas atas eksklusif
  return f;
}

export async function daftarLog({ page, limit, admin, action, targetType, targetId, from, to }: LogFilter) {
  const where: string[] = [];
  const args: unknown[] = [];
  const add = (sql: string, v: unknown) => { if (v !== undefined) { where.push(sql); args.push(v); } };
  add("l.admin_user_id = ?", admin);
  add("l.action = ?", action);
  add("l.target_type = ?", targetType);
  add("l.target_id = ?", targetId);
  add("l.created_at >= ?", from);
  add("l.created_at < ?", to);
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT l.id, l.admin_user_id, u.full_name AS admin_name, l.action, l.target_type, l.target_id, l.reason,
            l.before_json AS \`before\`, l.after_json AS \`after\`, l.created_at
     FROM admin_audit_logs l JOIN users u ON u.id = l.admin_user_id
     ${w} ORDER BY l.id DESC LIMIT ? OFFSET ?`,
    [...args, limit, (page - 1) * limit],
  );
  const [counts] = await db.query<RowDataPacket[]>(`SELECT COUNT(*) AS total FROM admin_audit_logs l ${w}`, args);
  return { data: rows, meta: { page, limit, total: Number(counts[0].total) } };
}
