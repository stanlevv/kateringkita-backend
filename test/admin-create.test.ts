import { beforeAll, describe, expect, test, vi } from "vitest";
import mysql from "mysql2/promise";
import { migrate } from "../src/scripts/migrate";
import { createAdmin, jalankan } from "../src/scripts/create-admin";
import { resetTestDatabase } from "./helpers/db";

describe("admin:create (A-05)", () => {
  let url: string;
  beforeAll(async () => {
    url = await resetTestDatabase();
    await migrate(url);
  });

  test("membuat user admin dengan hash bcrypt", async () => {
    const { id } = await createAdmin({ phone: "081300000001", fullName: "Admin Satu", password: "rahasia123" });
    const conn = await mysql.createConnection(url);
    const [rows] = await conn.query<mysql.RowDataPacket[]>("SELECT role, password_hash FROM users WHERE id = ?", [id]);
    await conn.end();
    expect(rows[0].role).toBe("admin");
    expect(rows[0].password_hash).not.toBe("rahasia123");
    expect(rows[0].password_hash).toMatch(/^\$2[aby]\$/);
  });

  test("nomor sudah dipakai → galat", async () => {
    await expect(createAdmin({ phone: "081300000001", fullName: "Dua", password: "rahasia123" })).rejects.toThrow("Nomor sudah terdaftar.");
  });

  test.each(["pendek1", "hurufsajaa", "12345678"])("sandi lemah %s → galat", async (password) => {
    await expect(createAdmin({ phone: "081300000002", fullName: "Dua", password })).rejects.toThrow();
  });

  test("nomor atau nama tidak valid → galat", async () => {
    await expect(createAdmin({ phone: "123", fullName: "Dua", password: "rahasia123" })).rejects.toThrow();
    await expect(createAdmin({ phone: "081300000003", fullName: " ", password: "rahasia123" })).rejects.toThrow();
  });

  test("CLI tanpa ADMIN_INITIAL_PASSWORD → kode 1", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await jalankan(["--phone", "081300000004", "--name", "Admin"], {});
    expect(code).toBe(1);
    expect(err).toHaveBeenCalledWith("ADMIN_INITIAL_PASSWORD belum diisi.");
    err.mockRestore();
  });

  test("CLI sukses → kode 0, sandi tidak dicetak", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await jalankan(["--phone", "081300000005", "--name", "Admin Lima"], { ADMIN_INITIAL_PASSWORD: "rahasia123" });
    expect(code).toBe(0);
    expect(JSON.stringify(log.mock.calls)).not.toContain("rahasia123");
    log.mockRestore();
  });

  test("CLI tanpa --phone/--name → kode 1", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await jalankan(["--phone", "081300000006"], { ADMIN_INITIAL_PASSWORD: "rahasia123" })).toBe(1);
    err.mockRestore();
  });
});
