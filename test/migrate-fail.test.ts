import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import mysql from "mysql2/promise";
import { expect, test } from "vitest";
import { migrate } from "../src/scripts/migrate";
import { resetTestDatabase } from "./helpers/db";

test("file migrasi rusak → error menyebut nama file dan tidak tercatat", async () => {
  const url = await resetTestDatabase();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kk-mig-"));
  fs.writeFileSync(path.join(dir, "001_rusak.sql"), "CREATE TABLE a (id INT); INI BUKAN SQL;");

  await expect(migrate(url, dir)).rejects.toThrow(/001_rusak\.sql/);

  const conn = await mysql.createConnection(url);
  const [rows] = await conn.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM schema_migrations");
  await conn.end();
  expect(rows[0].n).toBe(0);
});
