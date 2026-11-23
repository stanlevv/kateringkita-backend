import { RowDataPacket } from "mysql2";
import { PoolConnection } from "mysql2/promise";
import db from "../config/db";
import { AppError } from "../utils/errors";

export type AuditEntry = {
  adminId: number;
  action: string;
  targetType: string;
  targetId: string | number;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
};

const toJsonOrNull = (value: unknown) => (value === undefined ? null : JSON.stringify(value));

// Dipanggil di dalam transaksi yang sama dengan perubahannya.
export async function recordAudit(conn: Pick<PoolConnection, "query">, entry: AuditEntry): Promise<void> {
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

// Satu transaksi: commit bila fn selesai, rollback bila melempar. `isolasi` hanya berlaku untuk transaksi ini.
export async function withTransaction<T>(
  work: (conn: PoolConnection) => Promise<T>,
  isolationLevel?: "READ COMMITTED",
): Promise<T> {
  const conn = await db.getConnection();
  try {
    if (isolationLevel) await conn.query(`SET TRANSACTION ISOLATION LEVEL ${isolationLevel}`);
    await conn.beginTransaction();
    const result = await work(conn);
    await conn.commit();
    return result;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

export type Conn = PoolConnection;

// is_public hanya ada di baris promos (migrasi 014); baris lain tidak diberi kolom itu
export const withBooleanFlags = (row: RowDataPacket) => ({
  ...row,
  is_active: Boolean(row.is_active),
  ...("is_public" in row ? { is_public: Boolean(row.is_public) } : {}),
});

// Kunci satu baris (FOR UPDATE) di dalam transaksi; id tak valid atau tak ada -> 404.
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

const invalidFilter = (field: string, message: string): never => {
  throw new AppError(400, "VALIDATION_ERROR", "Filter tidak valid.", { [field]: [message] });
};
// "YYYY-MM-DD" (tanggal WIB) -> awal hari WIB dalam UTC
const parseWibDate = (field: string, value: string): Date => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const date = match ? new Date(Date.UTC(+match[1], +match[2] - 1, +match[3])) : null;
  if (!match || !date || date.getUTCMonth() !== +match[2] - 1)
    return invalidFilter(field, "Tanggal harus berformat TTTT-BB-HH.");
  return new Date(date.getTime() - 7 * 3600e3);
};

// Query string mentah -> filter tervalidasi (nilai tak valid -> 400).
export function parseLogFilter(query: Record<string, unknown>, page: number, limit: number): LogFilter {
  const readString = (key: string, max: number) => {
    const value = query[key];
    if (value === undefined || value === "") return undefined;
    if (typeof value !== "string" || value.length > max) return invalidFilter(key, `Maksimal ${max} karakter.`);
    return value;
  };
  const filter: LogFilter = {
    page,
    limit,
    action: readString("action", 60),
    targetType: readString("target_type", 30),
    targetId: readString("target_id", 40),
  };
  const admin = readString("admin", 10);
  if (admin !== undefined) {
    if (!/^[1-9]\d*$/.test(admin)) invalidFilter("admin", "Admin tidak valid.");
    filter.admin = Number(admin);
  }
  const from = readString("from", 10);
  const to = readString("to", 10);
  if (from) filter.from = parseWibDate("from", from);
  if (to) filter.to = new Date(parseWibDate("to", to).getTime() + 86400e3); // batas atas eksklusif
  return filter;
}

export async function listAuditLogs({ page, limit, admin, action, targetType, targetId, from, to }: LogFilter) {
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
