import request from "supertest";
import { expect, test } from "vitest";
import app from "../src/app";

// CORS_ORIGIN=http://localhost:3000 di vitest.config.ts
test("origin terdaftar diizinkan", async () => {
  const res = await request(app).get("/api/v1/tidak-ada").set("Origin", "http://localhost:3000");
  expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
});

test("origin lain tidak diizinkan", async () => {
  const res = await request(app).get("/api/v1/tidak-ada").set("Origin", "https://jahat.test");
  expect(res.headers["access-control-allow-origin"]).toBeUndefined();
});
