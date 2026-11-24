// Isi file: skrip migrasi database (`npm run migrate`). Migrasi = file SQL bernomor di database/migrations yang
// mengubah struktur database selangkah demi selangkah. Nama file yang sudah dijalankan dicatat di tabel
// schema_migrations, sehingga setiap file hanya dijalankan sekali. Nama file dan fungsi `migrate` juga dipakai test
// end-to-end repo web, jadi jangan diganti.
import "dotenv/config"; // harus pertama: env.ts (lewat db.ts) membaca process.env saat diimpor
import fs from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";
import { sslFor } from "../config/db";

const MIGRATIONS_DIR = path.join(__dirname, "../../database/migrations");

/**
 * Menjalankan file migrasi `*.sql` yang belum tercatat, urut menurut nama file.
 * @param databaseUrl alamat database `mysql://…`
 * @param dir         folder file migrasi (bawaan database/migrations; test memakai folder lain)
 * @returns nama file yang baru dijalankan (kosong bila tidak ada migrasi baru)
 * @throws Error berisi nama file yang gagal beserta alasannya; file sesudahnya tidak dijalankan
 */
export async function migrate(databaseUrl: string, dir = MIGRATIONS_DIR): Promise<string[]> {
  // 1. Buka satu sambungan khusus yang boleh menjalankan banyak perintah SQL sekaligus. Ini aman hanya di sini karena
  //    isinya file dari repo, bukan masukan pengguna.
  const conn = await mysql.createConnection({
    uri: databaseUrl,
    multipleStatements: true,
    timezone: "Z",
    ssl: sslFor(databaseUrl),
  });
  try {
    // 2. Siapkan tabel catatan migrasi, lalu cari file yang belum tercatat.
    await conn.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name VARCHAR(255) PRIMARY KEY, applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)",
    );
    const [rows] = await conn.query<mysql.RowDataPacket[]>("SELECT name FROM schema_migrations");
    const appliedNames = new Set(rows.map((row) => row.name));
    const pending = fs
      .readdirSync(dir)
      .filter((fileName) => fileName.endsWith(".sql") && !appliedNames.has(fileName))
      .sort();
    // 3. Jalankan satu per satu dan catat setiap file yang berhasil.
    for (const name of pending) {
      try {
        await conn.query(fs.readFileSync(path.join(dir, name), "utf8"));
      } catch (error) {
        // Perintah pengubah struktur (DDL) di MySQL langsung tersimpan sendiri-sendiri, jadi perintah sebelum yang
        // gagal tetap tersimpan dan harus dibersihkan manual.
        throw new Error(
          `Migrasi ${name} gagal: ${(error as Error).message}. Hapus manual objek yang sempat dibuat file ini, lalu jalankan ulang.`,
        );
      }
      await conn.query("INSERT INTO schema_migrations (name) VALUES (?)", [name]);
    }
    return pending;
  } finally {
    await conn.end();
  }
}

// Hanya berjalan bila file ini dijalankan langsung (bukan diimpor test); alamat database diambil dari env.
if (require.main === module) {
  const { env } = require("../config/env");
  migrate(env.DATABASE_URL).then(
    (applied) => console.log(applied.length ? `Diterapkan: ${applied.join(", ")}` : "Tidak ada migrasi baru."),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
