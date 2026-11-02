import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import mysql from "mysql2/promise";
import { beforeAll, describe, expect, test } from "vitest";
import { migrate } from "../src/db/migrate";
import { registerMerchant } from "../src/auth/service";
import { resetTestDatabase } from "./helpers/db";

const MIGRATIONS = path.join(__dirname, "../migrations");

describe("migrasi 002_admin (A-05)", () => {
  let url: string;
  let lamaId: number;

  beforeAll(async () => {
    url = await resetTestDatabase();
    // hanya 001 dulu, lalu penjual lama, lalu 002
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mig-"));
    fs.copyFileSync(path.join(MIGRATIONS, "001_init.sql"), path.join(dir, "001_init.sql"));
    await migrate(url, dir);
    const conn = await mysql.createConnection(url);
    const [u] = await conn.query<mysql.ResultSetHeader>(
      "INSERT INTO users (role, full_name, phone, password_hash) VALUES ('merchant','Lama','081200000001','x')",
    );
    const [m] = await conn.query<mysql.ResultSetHeader>(
      "INSERT INTO merchants (user_id, merchant_type_id, business_name, slug, address, wa_number) VALUES (?,1,'Toko Lama','toko-lama','Jl. A','081200000001')",
      [u.insertId],
    );
    lamaId = m.insertId;
    await conn.end();
    expect(await migrate(url)).toEqual(["002_admin.sql", "003_checkout.sql"]);
  });

  const query = async (sql: string, params: unknown[] = []) => {
    const conn = await mysql.createConnection(url);
    const [rows] = await conn.query<mysql.RowDataPacket[]>(sql, params);
    await conn.end();
    return rows;
  };

  test("kolom baru merchants, merchant_types, dan tabel admin_audit_logs ada", async () => {
    const cols = await query(
      `SELECT TABLE_NAME t, COLUMN_NAME c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
       AND ((TABLE_NAME='merchants' AND COLUMN_NAME IN ('verification_status','verification_note','suspended_at','suspended_reason'))
         OR (TABLE_NAME='merchant_types' AND COLUMN_NAME IN ('is_active','sort_order'))
         OR TABLE_NAME='admin_audit_logs')`,
    );
    const names = cols.map((r) => `${r.t}.${r.c}`);
    for (const n of [
      "merchants.verification_status", "merchants.verification_note", "merchants.suspended_at", "merchants.suspended_reason",
      "merchant_types.is_active", "merchant_types.sort_order",
      "admin_audit_logs.id", "admin_audit_logs.admin_user_id", "admin_audit_logs.action", "admin_audit_logs.target_type",
      "admin_audit_logs.target_id", "admin_audit_logs.reason", "admin_audit_logs.before_json", "admin_audit_logs.after_json",
      "admin_audit_logs.created_at",
    ]) expect(names).toContain(n);
  });

  test("merchant_types.sort_order lama = id", async () => {
    const rows = await query("SELECT COUNT(*) n FROM merchant_types WHERE sort_order <> id");
    expect(rows[0].n).toBe(0);
  });

  test("penjual sebelum 002 → verified dengan verified_at (K2)", async () => {
    const [r] = await query("SELECT verification_status s, verified_at v FROM merchants WHERE id = ?", [lamaId]);
    expect(r.s).toBe("verified");
    expect(r.v).not.toBeNull();
  });

  test("penjual yang daftar setelah 002 → pending", async () => {
    const { merchant } = await registerMerchant({
      full_name: "Baru", phone: "081200000002", password: "rahasia123",
      business_name: "Toko Baru", merchant_type_id: 1, address: "Jl. B",
    });
    const [r] = await query("SELECT verification_status s, verified_at v FROM merchants WHERE id = ?", [merchant.id]);
    expect(r.s).toBe("pending");
    expect(r.v).toBeNull();
  });
});
