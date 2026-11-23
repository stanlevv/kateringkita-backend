import { ResultSetHeader, RowDataPacket } from "mysql2";
import db from "../config/db";

// F23 log server: error 5xx & request lambat untuk dashboard admin; disimpan 30 hari.
export const SLOW_REQUEST_MS = 2000;
const RETENTION_DAYS = 30;

export type ServerLogEntry = {
  requestId: string | null;
  level: "error" | "slow";
  method: string;
  path: string;
  status: number;
  durationMs: number;
  message: string | null;
  userId: number | null;
};

export async function saveServerLog(entry: ServerLogEntry): Promise<void> {
  await db.query(
    "INSERT INTO server_logs (request_id, level, method, path, status, duration_ms, message, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [
      entry.requestId?.slice(0, 128) ?? null,
      entry.level,
      entry.method.slice(0, 10),
      entry.path.slice(0, 255),
      entry.status,
      entry.durationMs,
      entry.message?.slice(0, 500) ?? null,
      entry.userId,
    ],
  );
}

export type ServerLogFilter = { level?: "error" | "slow"; q?: string; page: number; limit: number };

export async function listServerLogs(filter: ServerLogFilter) {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.level) (where.push("level = ?"), args.push(filter.level));
  // q = request ID persis, atau bagian path
  if (filter.q)
    (where.push("(request_id = ? OR path LIKE ?)"), args.push(filter.q, `%${filter.q.replace(/[\\%_]/g, "\\$&")}%`));
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, request_id, level, method, path, status, duration_ms, message, user_id, created_at FROM server_logs ${whereSql}
     ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...args, filter.limit, (filter.page - 1) * filter.limit],
  );
  const [[countRow]] = await db.query<RowDataPacket[]>(`SELECT COUNT(*) AS total FROM server_logs ${whereSql}`, args);
  return { data: rows, meta: { page: filter.page, limit: filter.limit, total: Number(countRow.total) } };
}

/** Kondisi server + ringkasan 24 jam (per jam UTC, jam kosong = 0). */
export async function getServerStatus() {
  const startedAt = Date.now();
  let dbOk = true;
  let lastMigration: string | null = null;
  try {
    const [[migration]] = await db.query<RowDataPacket[]>(
      "SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1",
    );
    lastMigration = migration?.name ?? null;
  } catch {
    dbOk = false;
  }
  const dbLatencyMs = Date.now() - startedAt;
  const [rows] = await db
    .query<RowDataPacket[]>(
      `SELECT DATE_FORMAT(created_at, '%Y-%m-%dT%H:00:00Z') AS jam, SUM(level = 'error') AS error, SUM(level = 'slow') AS lambat
     FROM server_logs WHERE created_at >= UTC_TIMESTAMP() - INTERVAL 24 HOUR GROUP BY 1`,
    )
    .catch(() => [[]] as unknown as [RowDataPacket[]]);
  const countsByHour = new Map(
    rows.map((row) => [String(row.jam), { error: Number(row.error), lambat: Number(row.lambat) }]),
  );
  const currentHour = new Date();
  currentHour.setUTCMinutes(0, 0, 0);
  const hourlyCounts = Array.from({ length: 24 }, (_, i) => {
    const hourLabel = new Date(currentHour.getTime() - (23 - i) * 3600e3).toISOString().replace(".000Z", "Z");
    return { jam: hourLabel, ...(countsByHour.get(hourLabel) ?? { error: 0, lambat: 0 }) };
  });
  return {
    uptime_s: Math.round(process.uptime()),
    memori_mb: Math.round(process.memoryUsage().rss / 1048576),
    node: process.version,
    db: { ok: dbOk, latency_ms: dbLatencyMs, migrasi_terakhir: lastMigration },
    ringkas_24j: {
      error: hourlyCounts.reduce((sum, hour) => sum + hour.error, 0),
      lambat: hourlyCounts.reduce((sum, hour) => sum + hour.lambat, 0),
    },
    per_jam: hourlyCounts,
  };
}

export async function cleanupServerLogs(): Promise<void> {
  // AUD-44: per 10.000 baris (transaksi kecil), diulang sampai habis; dibatasi 100 putaran agar satu pembersihan tidak tanpa akhir
  for (let i = 0; i < 100; i++) {
    const [result] = await db.query<ResultSetHeader>(
      `DELETE FROM server_logs WHERE created_at < UTC_TIMESTAMP() - INTERVAL ${RETENTION_DAYS} DAY LIMIT 10000`,
    );
    if (result.affectedRows < 10000) break;
  }
  // F25: riwayat pemakaian AI disimpan 90 hari
  await db.query("DELETE FROM ai_usage WHERE created_at < UTC_TIMESTAMP() - INTERVAL 90 DAY LIMIT 10000");
}

/** Pembersihan berkala (saat mulai & tiap 6 jam); gagal hanya dicatat ke konsol. */
export function startLogCleanupJob(intervalMs = 6 * 3600e3): () => void {
  const runCleanup = () =>
    void cleanupServerLogs().catch((error) => console.error("[log] pembersihan gagal:", (error as Error).message));
  runCleanup();
  const timer = setInterval(runCleanup, intervalMs);
  return () => clearInterval(timer);
}
