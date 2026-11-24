// Isi file: sambungan ke database MySQL/TiDB yang dipakai bersama oleh semua service (lapisan paling bawah pada alur
// routes → handlers → services → database). Yang diekspor adalah "pool koneksi": kumpulan sambungan database yang
// dibuka lalu dipinjamkan bergantian ke setiap query, supaya tidak perlu membuka sambungan baru di setiap request.
import mysql from "mysql2/promise";
import { env } from "./env";

/**
 * Menentukan pengaturan TLS (sambungan terenkripsi) untuk sebuah alamat database. TiDB Cloud, database yang dipakai
 * server production, menolak sambungan tanpa TLS; database lokal tidak memakainya.
 * @param url alamat database `mysql://…`
 * @returns pengaturan TLS untuk alamat TiDB Cloud, atau `undefined` (tanpa TLS) untuk alamat lain
 */
export const sslFor = (url: string) =>
  url.includes("tidbcloud.com") ? { rejectUnauthorized: true, minVersion: "TLSv1.2" } : undefined;

// Paling banyak 10 sambungan terbuka; query yang datang saat semuanya terpakai menunggu giliran (antrean tanpa batas).
// `timezone: "Z"` membuat tanggal dari/ke database dibaca sebagai UTC.
const pool = mysql.createPool({
  uri: env.DATABASE_URL,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  timezone: "Z",
  ssl: sslFor(env.DATABASE_URL),
});

// CURRENT_TIMESTAMP mengikuti zona waktu sesi database, sedangkan semua perbandingan waktu di kode ini menganggap UTC.
// Karena itu setiap sambungan baru langsung diatur ke UTC; perintah ini diantrekan sebelum query pertama pemakainya.
pool.pool.on("connection", (conn) => {
  conn.query("SET time_zone = '+00:00'", (error) => {
    if (!error) return;
    console.error("Gagal mengatur zona waktu koneksi:", error.message);
    conn.destroy(); // koneksi tanpa UTC tidak boleh dipakai ulang oleh pool
  });
});

/**
 * Pool koneksi database bersama. `db.query(...)` meminjam satu sambungan untuk satu query lalu mengembalikannya;
 * untuk transaksi, pinjam satu sambungan dengan `db.getConnection()` supaya semua query memakai sambungan yang sama.
 */
export default pool;
