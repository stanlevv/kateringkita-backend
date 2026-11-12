import fs from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";
import { beforeAll, describe, expect, test } from "vitest";
import { migrate } from "../src/scripts/migrate";
import { resetTestDatabase } from "./helpers/db";

// semua berkas migrasi, urut nama (sama dengan urutan migrate())
const SEMUA = fs.readdirSync(path.join(__dirname, "../database/migrations")).filter((f) => f.endsWith(".sql")).sort();

describe("migrasi", () => {
  let url: string;
  let firstRun: string[];

  beforeAll(async () => {
    url = await resetTestDatabase();
    firstRun = await migrate(url);
  });

  test("DB kosong → semua migrasi diterapkan berurutan, 28 tabel + schema_migrations", async () => {
    expect(firstRun).toEqual(SEMUA);
    expect(firstRun.slice(0, 4)).toEqual(["001_init.sql", "002_admin.sql", "003_checkout.sql", "004_moderasi.sql"]);
    const conn = await mysql.createConnection(url);
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()",
    );
    await conn.end();
    // 001–003: 22 tabel; 005 meja, 006 ai_providers, 007 server_logs, 008 ai_usage, 010 payouts, 011 merchant_favorites
    expect(rows[0].n).toBe(29);
  });

  test("seed master terisi", async () => {
    const conn = await mysql.createConnection(url);
    const [rows] = await conn.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM categories");
    await conn.end();
    expect(rows[0].n).toBe(7);
  });

  test("dijalankan ulang → tidak ada yang diterapkan", async () => {
    expect(await migrate(url)).toEqual([]);
  });

  test("menghapus user pemilik toko ditolak (bukan cascade) — BE-12", async () => {
    const conn = await mysql.createConnection(url);
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS
       WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'merchants' AND REFERENCED_TABLE_NAME = 'users'`,
    );
    await conn.end();
    expect(rows[0].DELETE_RULE).toBe("RESTRICT");
  });
});
