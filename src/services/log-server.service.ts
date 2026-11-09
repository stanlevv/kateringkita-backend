import { RowDataPacket } from "mysql2";
import db from "../config/db";

// F23 log server: error 5xx & request lambat untuk dashboard admin; disimpan 30 hari.
export const LAMBAT_MS = 2000;
const SIMPAN_HARI = 30;

export type EntriLog = {
  requestId: string | null; level: "error" | "slow"; method: string; path: string; status: number; durationMs: number;
  message: string | null; userId: number | null;
};

export async function catatLog(e: EntriLog): Promise<void> {
  await db.query(
    "INSERT INTO server_logs (request_id, level, method, path, status, duration_ms, message, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [e.requestId?.slice(0, 128) ?? null, e.level, e.method.slice(0, 10), e.path.slice(0, 255), e.status, e.durationMs, e.message?.slice(0, 500) ?? null, e.userId],
  );
}

export type FilterLog = { level?: "error" | "slow"; q?: string; page: number; limit: number };

export async function daftarLogServer(f: FilterLog) {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.level) where.push("level = ?"), args.push(f.level);
  // q = request ID persis, atau bagian path
  if (f.q) where.push("(request_id = ? OR path LIKE ?)"), args.push(f.q, `%${f.q.replace(/[\\%_]/g, "\\$&")}%`);
  const syarat = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, request_id, level, method, path, status, duration_ms, message, user_id, created_at FROM server_logs ${syarat}
     ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...args, f.limit, (f.page - 1) * f.limit],
  );
  const [[n]] = await db.query<RowDataPacket[]>(`SELECT COUNT(*) AS total FROM server_logs ${syarat}`, args);
  return { data: rows, meta: { page: f.page, limit: f.limit, total: Number(n.total) } };
}

/** Kondisi server + ringkasan 24 jam (per jam UTC, jam kosong = 0). */
export async function statusServer() {
  const mulai = Date.now();
  let dbOk = true;
  let migrasi: string | null = null;
  try {
    const [[m]] = await db.query<RowDataPacket[]>("SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1");
    migrasi = m?.name ?? null;
  } catch {
    dbOk = false;
  }
  const dbMs = Date.now() - mulai;
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT DATE_FORMAT(created_at, '%Y-%m-%dT%H:00:00Z') AS jam, SUM(level = 'error') AS error, SUM(level = 'slow') AS lambat
     FROM server_logs WHERE created_at >= UTC_TIMESTAMP() - INTERVAL 24 HOUR GROUP BY 1`,
  ).catch(() => [[]] as unknown as [RowDataPacket[]]);
  const per = new Map(rows.map((r) => [String(r.jam), { error: Number(r.error), lambat: Number(r.lambat) }]));
  const sekarang = new Date();
  sekarang.setUTCMinutes(0, 0, 0);
  const per_jam = Array.from({ length: 24 }, (_, i) => {
    const jam = new Date(sekarang.getTime() - (23 - i) * 3600e3).toISOString().replace(".000Z", "Z");
    return { jam, ...(per.get(jam) ?? { error: 0, lambat: 0 }) };
  });
  return {
    uptime_s: Math.round(process.uptime()),
    memori_mb: Math.round(process.memoryUsage().rss / 1048576),
    node: process.version,
    db: { ok: dbOk, latency_ms: dbMs, migrasi_terakhir: migrasi },
    ringkas_24j: { error: per_jam.reduce((s, j) => s + j.error, 0), lambat: per_jam.reduce((s, j) => s + j.lambat, 0) },
    per_jam,
  };
}

export async function bersihkanLog(): Promise<void> {
  await db.query(`DELETE FROM server_logs WHERE created_at < UTC_TIMESTAMP() - INTERVAL ${SIMPAN_HARI} DAY LIMIT 10000`);
}

/** Pembersihan berkala (saat mulai & tiap 6 jam); gagal hanya dicatat ke konsol. */
export function mulaiJobBersihLog(ms = 6 * 3600e3): () => void {
  const jalan = () => void bersihkanLog().catch((e) => console.error("[log] pembersihan gagal:", (e as Error).message));
  jalan();
  const t = setInterval(jalan, ms);
  return () => clearInterval(t);
}
