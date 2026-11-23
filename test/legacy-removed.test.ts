import request from "supertest";
import { beforeAll, expect, test } from "vitest";
import app from "../src/app";
import { migrate } from "../src/scripts/migrate";
import { resetTestDatabase } from "./helpers/db";

beforeAll(async () => {
  await migrate(await resetTestDatabase()); // app.ts membaca app_settings (pemeliharaan)
});

test("endpoint auth lama /api/auth/login sudah dihapus → 404", async () => {
  const res = await request(app).post("/api/auth/login").send({ email: "a@b.c", password: "x" });
  expect(res.status).toBe(404);
});

test("router menu lama /api/menus sudah dihapus → 404", async () => {
  expect((await request(app).get("/api/menus")).status).toBe(404);
  expect((await request(app).delete("/api/menus/1").set("Authorization", "Bearer x")).status).toBe(404);
});
