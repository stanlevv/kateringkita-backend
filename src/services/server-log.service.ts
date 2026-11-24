// Isi file: log server untuk dasbor server admin super (GET /admin/server-status dan /admin/server-logs). Yang dicatat
// hanya request bermasalah: galat server 5xx (status 500 ke atas, artinya ada yang rusak di sisi server, bukan salah
// isian pengguna) dan request lambat (lebih dari 2 detik). Pencatatnya middleware/request-logger.ts; alur dasbor:
// routes/admin.ts → handlers/server-log.handler.ts → file ini → database. Log disimpan 30 hari, riwayat pemakaian AI
// 90 hari; pembersihannya berjalan otomatis dari server.ts.
import { ResultSetHeader, RowDataPacket } from "mysql2";
import db from "../config/db";

/** Batas request dianggap lambat, dalam milidetik. */
export const SLOW_REQUEST_MS = 2000;
// Lama log server disimpan sebelum dihapus pembersihan berkala.
const RETENTION_DAYS = 30;

/** Satu catatan log server: id request, jenis (`error`/`slow`), method, path, status, durasi, pesan, dan pengguna. */
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

/**
 * Menyimpan satu catatan log server; teks dipotong sesuai panjang kolom.
 * @param entry catatan dari middleware request-logger
 * @returns selesai setelah tersimpan
 */
export async function saveServerLog(entry: ServerLogEntry): Promise<void> {
  // 1. Satu INSERT ke tabel server_logs.
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

/** Filter daftar log: jenis, kata kunci (`q`), dan halaman. */
export type ServerLogFilter = { level?: "error" | "slow"; q?: string; page: number; limit: number };

/**
 * Daftar log server per halaman, terbaru dulu.
 * @param filter `level` = `error`/`slow`; `q` = id request persis atau sebagian path; `page`, `limit`
 * @returns `{ data, meta: { page, limit, total } }`
 */
export async function listServerLogs(filter: ServerLogFilter) {
  // 1. Susun syarat; tanda khusus LIKE di kata kunci dibuat harfiah.
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.level) (where.push("level = ?"), args.push(filter.level));
  if (filter.q)
    (where.push("(request_id = ? OR path LIKE ?)"), args.push(filter.q, `%${filter.q.replace(/[\\%_]/g, "\\$&")}%`));
  // 2. Ambil satu halaman lalu hitung totalnya.
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, request_id, level, method, path, status, duration_ms, message, user_id, created_at FROM server_logs ${whereSql}
     ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...args, filter.limit, (filter.page - 1) * filter.limit],
  );
  const [[countRow]] = await db.query<RowDataPacket[]>(`SELECT COUNT(*) AS total FROM server_logs ${whereSql}`, args);
  return { data: rows, meta: { page: filter.page, limit: filter.limit, total: Number(countRow.total) } };
}

/**
 * Kondisi server sekarang dan ringkasan log 24 jam terakhir. Kunci JSON jawabannya berbahasa Indonesia karena itu
 * kontrak dengan dasbor admin.
 * @returns `uptime_s` (lama server menyala, detik), `memori_mb`, versi `node`, `db` (bisa dihubungi atau tidak,
 *          latensi, migrasi terakhir), `ringkas_24j` (jumlah error dan lambat), dan `per_jam` (24 jam terakhir per jam
 *          UTC; jam tanpa log bernilai 0)
 */
export async function getServerStatus() {
  // 1. Uji database dengan membaca migrasi terakhir sambil mengukur latensinya; gagal = database tidak bisa dihubungi.
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
  // 2. Hitung error dan lambat per jam selama 24 jam terakhir (gagal membaca = dianggap kosong).
  const [rows] = await db
    .query<RowDataPacket[]>(
      `SELECT DATE_FORMAT(created_at, '%Y-%m-%dT%H:00:00Z') AS jam, SUM(level = 'error') AS error, SUM(level = 'slow') AS lambat
     FROM server_logs WHERE created_at >= UTC_TIMESTAMP() - INTERVAL 24 HOUR GROUP BY 1`,
    )
    .catch(() => [[]] as unknown as [RowDataPacket[]]);
  const countsByHour = new Map(
    rows.map((row) => [String(row.jam), { error: Number(row.error), lambat: Number(row.lambat) }]),
  );
  // 3. Isi 24 slot jam, dari 23 jam lalu sampai jam sekarang, supaya jam tanpa log tetap muncul.
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

/**
 * Menghapus log server yang lebih tua dari 30 hari dan riwayat pemakaian AI yang lebih tua dari 90 hari.
 * @returns selesai setelah pembersihan
 */
export async function cleanupServerLogs(): Promise<void> {
  // 1. Hapus log server per 10.000 baris (transaksi kecil) sampai habis; dibatasi 100 putaran supaya satu pembersihan
  //    tidak berjalan tanpa akhir.
  for (let i = 0; i < 100; i++) {
    const [result] = await db.query<ResultSetHeader>(
      `DELETE FROM server_logs WHERE created_at < UTC_TIMESTAMP() - INTERVAL ${RETENTION_DAYS} DAY LIMIT 10000`,
    );
    if (result.affectedRows < 10000) break;
  }
  // 2. Riwayat pemakaian AI disimpan 90 hari (sekali hapus paling banyak 10.000 baris).
  await db.query("DELETE FROM ai_usage WHERE created_at < UTC_TIMESTAMP() - INTERVAL 90 DAY LIMIT 10000");
}

/**
 * Menjalankan pembersihan log saat server mulai lalu berulang setiap 6 jam. Gagal membersihkan hanya ditulis ke log
 * konsol.
 * @param intervalMs jarak antar pembersihan dalam milidetik (bawaan 6 jam)
 * @returns fungsi untuk menghentikan pengulangan
 */
export function startLogCleanupJob(intervalMs = 6 * 3600e3): () => void {
  const runCleanup = () =>
    void cleanupServerLogs().catch((error) => console.error("[log] pembersihan gagal:", (error as Error).message));
  runCleanup();
  const timer = setInterval(runCleanup, intervalMs);
  return () => clearInterval(timer);
}
