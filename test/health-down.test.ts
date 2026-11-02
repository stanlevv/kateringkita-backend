import request from "supertest";
import { expect, test, vi } from "vitest";

test("health → 503 saat DB tidak terjangkau", async () => {
  // port 1 selalu menolak koneksi; env dibaca saat app diimpor
  process.env.DATABASE_URL = "mysql://root:root@127.0.0.1:1/kateringkita_test";
  const { default: app } = await import("../src/app");
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});

  const res = await request(app).get("/api/v1/health");

  expect(res.status).toBe(503);
  expect(res.body.error.code).toBe("SERVICE_UNAVAILABLE");
  spy.mockRestore();
});
