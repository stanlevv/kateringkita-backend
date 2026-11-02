import mysql from "mysql2/promise";
import { beforeAll, describe, expect, test } from "vitest";
import { migrate } from "../src/db/migrate";
import { resetTestDatabase } from "./helpers/db";

describe("migrasi", () => {
  let url: string;
  let firstRun: string[];

  beforeAll(async () => {
    url = await resetTestDatabase();
    firstRun = await migrate(url);
  });

  test("DB kosong → 001–003 diterapkan, 22 tabel + schema_migrations", async () => {
    expect(firstRun).toEqual(["001_init.sql", "002_admin.sql", "003_checkout.sql"]);
    const conn = await mysql.createConnection(url);
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()",
    );
    await conn.end();
    expect(rows[0].n).toBe(23);
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
