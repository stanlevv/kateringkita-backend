import mysql from "mysql2/promise";
import { env } from "./env";

// TiDB Cloud mewajibkan TLS
export const sslFor = (url: string) =>
  url.includes("tidbcloud.com") ? { rejectUnauthorized: true, minVersion: "TLSv1.2" } : undefined;

const pool = mysql.createPool({
  uri: env.DATABASE_URL,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  timezone: "Z",
  ssl: sslFor(env.DATABASE_URL),
});

// CURRENT_TIMESTAMP mengikuti time_zone sesi; semua perbandingan kita mengasumsikan UTC.
// Perintah ini diantrekan di koneksi baru sebelum query pertama pemakai.
pool.pool.on("connection", (conn) => {
  conn.query("SET time_zone = '+00:00'", (err) => {
    if (!err) return;
    console.error("Gagal mengatur zona waktu koneksi:", err.message);
    conn.destroy(); // koneksi tanpa UTC tidak boleh dipakai ulang oleh pool
  });
});

export default pool;
