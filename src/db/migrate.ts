import "dotenv/config"; // harus pertama: env.ts (lewat db.ts) membaca process.env saat diimpor
import fs from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";
import { sslFor } from "../config/db";

const MIGRATIONS_DIR = path.join(__dirname, "../../migrations");

// Menjalankan migrations/*.sql yang belum tercatat, urut nama. Mengembalikan nama file yang diterapkan.
export async function migrate(databaseUrl: string, dir = MIGRATIONS_DIR): Promise<string[]> {
  // multipleStatements hanya di koneksi ini: isinya file dari repo, bukan input pengguna
  const conn = await mysql.createConnection({ uri: databaseUrl, multipleStatements: true, timezone: "Z", ssl: sslFor(databaseUrl) });
  try {
    await conn.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name VARCHAR(255) PRIMARY KEY, applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)",
    );
    const [rows] = await conn.query<mysql.RowDataPacket[]>("SELECT name FROM schema_migrations");
    const done = new Set(rows.map((r) => r.name));
    const pending = fs.readdirSync(dir).filter((f) => f.endsWith(".sql") && !done.has(f)).sort();
    for (const name of pending) {
      try {
        await conn.query(fs.readFileSync(path.join(dir, name), "utf8"));
      } catch (err) {
        // DDL MySQL auto-commit: pernyataan sebelum yang gagal tetap tersimpan
        throw new Error(
          `Migrasi ${name} gagal: ${(err as Error).message}. Hapus manual objek yang sempat dibuat file ini, lalu jalankan ulang.`,
        );
      }
      await conn.query("INSERT INTO schema_migrations (name) VALUES (?)", [name]);
    }
    return pending;
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  const { env } = require("../config/env");
  migrate(env.DATABASE_URL).then(
    (applied) => console.log(applied.length ? `Diterapkan: ${applied.join(", ")}` : "Tidak ada migrasi baru."),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
