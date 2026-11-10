import { describe, expect, test, vi } from "vitest";
import { loadEnv } from "../src/config/env";

const valid = {
  DATABASE_URL: "mysql://root:root@localhost:3306/kateringkita",
  JWT_SECRET: "x".repeat(32),
};

describe("loadEnv", () => {
  test("nilai default terisi", () => {
    const env = loadEnv(valid);
    expect(env.PORT).toBe(5000);
    expect(env.JWT_TTL_WEB).toBe("1d");
    expect(env.JWT_TTL_MOBILE).toBe("30d");
  });

  test("tanpa JWT_SECRET ditolak", () => {
    expect(() => loadEnv({ DATABASE_URL: valid.DATABASE_URL })).toThrow(/JWT_SECRET/);
  });

  test("JWT_SECRET pendek ditolak", () => {
    expect(() => loadEnv({ ...valid, JWT_SECRET: "pendek" })).toThrow(/JWT_SECRET/);
  });

  test("JWT_TTL salah format ditolak saat start", () => {
    expect(() => loadEnv({ ...valid, JWT_TTL_WEB: "1 hari" })).toThrow(/JWT_TTL_WEB/);
    expect(() => loadEnv({ ...valid, JWT_TTL_MOBILE: "30" })).toThrow(/JWT_TTL_MOBILE/);
  });

  test("DATABASE_URL wajib mysql://", () => {
    expect(() => loadEnv({ ...valid, DATABASE_URL: "postgres://x" })).toThrow(/DATABASE_URL/);
  });

  test("CORS_ORIGIN dipecah per koma", () => {
    const env = loadEnv({ ...valid, CORS_ORIGIN: "http://a.test, http://b.test" });
    expect(env.CORS_ORIGIN).toEqual(["http://a.test", "http://b.test"]);
  });

  test("production lengkap diterima", () => {
    expect(() => loadEnv({ ...valid, NODE_ENV: "production", CORS_ORIGIN: "https://a.test" })).not.toThrow();
  });

  test("production tanpa CORS_ORIGIN ditolak", () => {
    expect(() => loadEnv({ ...valid, NODE_ENV: "production" })).toThrow(/CORS_ORIGIN/);
  });

  test("R2_* semua-atau-tidak (D13)", () => {
    const r2 = { R2_ACCOUNT_ID: "acc", R2_ACCESS_KEY_ID: "id", R2_SECRET_ACCESS_KEY: "rahasia", R2_BUCKET: "b", R2_PUBLIC_URL: "https://foto.test/" };
    // terisi sebagian: tidak menggagalkan release, semua R2 dikosongkan (unggah mati) + peringatan nama variabel
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadEnv({ ...valid, R2_BUCKET: "b" }).R2_BUCKET).toBeUndefined();
    expect(loadEnv({ ...valid, ...r2, R2_SECRET_ACCESS_KEY: "" }).R2_ACCOUNT_ID).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("kosong: R2_SECRET_ACCESS_KEY"));
    expect(JSON.stringify(warn.mock.calls)).not.toContain("rahasia");
    warn.mockRestore();
    expect(loadEnv({ ...valid, R2_ACCOUNT_ID: "", R2_BUCKET: "" }).R2_BUCKET).toBeUndefined();
    expect(loadEnv({ ...valid, ...r2 }).R2_PUBLIC_URL).toBe("https://foto.test");
    expect(() => loadEnv({ ...valid, ...r2, R2_PUBLIC_URL: "http://foto.test" })).toThrow(/R2_PUBLIC_URL/);
  });

  test("SMTP_* semua-atau-tidak (F11)", () => {
    const smtp = { SMTP_HOST: "smtp.test", SMTP_PORT: "465", SMTP_USER: "u", SMTP_PASS: "p", SMTP_FROM: "KateringKita <no-reply@test>" };
    expect(() => loadEnv({ ...valid, SMTP_HOST: "smtp.test" })).toThrow("SMTP_* harus diisi semua atau dikosongkan semua");
    expect(loadEnv({ ...valid, ...smtp }).SMTP_PORT).toBe(465);
    expect(loadEnv({ ...valid, SMTP_HOST: "" }).SMTP_HOST).toBeUndefined();
  });
});
