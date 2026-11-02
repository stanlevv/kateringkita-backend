import { beforeAll, describe, expect, test, vi } from "vitest";
import mysql from "mysql2/promise";
import { migrate } from "../src/db/migrate";
import { createAdmin } from "../src/admin/create";
import { hostLokal, jalankan } from "../src/db/seed-demo";
import { resetTestDatabase } from "./helpers/db";

describe("seed demo (F18)", () => {
  let url: string;
  const query = async (sql: string) => {
    const conn = await mysql.createConnection(url);
    const [rows] = await conn.query<mysql.RowDataPacket[]>(sql);
    await conn.end();
    return rows;
  };
  beforeAll(async () => {
    url = await resetTestDatabase();
    await migrate(url);
  });

  test("menolak di produksi dan tanpa DEMO_PASSWORD", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await jalankan({ NODE_ENV: "production", DEMO_PASSWORD: "rahasia123" })).toBe(1);
    expect(await jalankan({})).toBe(1);
    // sandi lemah ditolak dengan aturan sandi yang sama dengan registrasi (review akhir A2)
    expect(await jalankan({ DEMO_PASSWORD: "lemah" })).toBe(1);
    expect(await jalankan({ DEMO_PASSWORD: "hanyahuruf" })).toBe(1);
    // DB bukan lokal ditolak kecuali --paksa (review akhir A2)
    expect(await jalankan({ DEMO_PASSWORD: "rahasia123", DATABASE_URL: "mysql://u:p@db.contoh.com:4000/kk" })).toBe(1);
    err.mockRestore();
    expect(await query("SELECT id FROM merchants")).toHaveLength(0);
  });

  test("tanpa admin: 4 penjual dengan status berbeda, tanpa log", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await jalankan({ DEMO_PASSWORD: "rahasia123" })).toBe(0);
    log.mockRestore();
    const rows = await query("SELECT verification_status s, verification_note n, suspended_reason r FROM merchants ORDER BY id");
    expect(rows.map((r) => r.s)).toEqual(["pending", "needs_fix", "verified", "suspended"]);
    expect(rows[1].n).toBeTruthy();
    expect(rows[3].r).toBeTruthy();
    expect(await query("SELECT id FROM admin_audit_logs")).toHaveLength(0);
    expect(await query("SELECT id FROM menus WHERE image_url IS NULL")).not.toHaveLength(0);
    // tanpa nama berkas palsu: menu demo tidak punya foto (review akhir A2)
    expect(await query("SELECT id FROM menus WHERE image_url IS NOT NULL")).toHaveLength(0);
  });

  test("hostLokal: hanya localhost/127.0.0.1/::1", () => {
    expect(hostLokal("mysql://root@127.0.0.1:3306/kk")).toBe(true);
    expect(hostLokal("mysql://root@localhost/kk")).toBe(true);
    expect(hostLokal("mysql://root@[::1]:3306/kk")).toBe(true);
    expect(hostLokal("mysql://u:p@gateway01.tidbcloud.com:4000/kk")).toBe(false);
    expect(hostLokal("bukan url")).toBe(false);
  });

  test("diulang setelah ada admin: tidak menggandakan penjual, log dibuat sekali", async () => {
    await createAdmin({ phone: "081300000099", fullName: "Admin Uji", password: "rahasia123" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await jalankan({ DEMO_PASSWORD: "rahasia123" })).toBe(0);
    expect(await jalankan({ DEMO_PASSWORD: "rahasia123" })).toBe(0);
    log.mockRestore();
    expect(await query("SELECT id FROM merchants")).toHaveLength(4);
    expect(await query("SELECT id FROM admin_audit_logs")).toHaveLength(3);
  });
});
