import request from "supertest";
import { beforeAll, expect, test } from "vitest";
import app from "../src/app";
import { resetTestDatabase } from "./helpers/db";

// DB uji harus ada; pesan jelas bila MySQL tidak jalan (D-C)
beforeAll(resetTestDatabase);

test("health → 200 saat DB uji terjangkau", async () => {
  const res = await request(app).get("/api/v1/health");
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ data: { status: "ok", db: "ok" } });
});
