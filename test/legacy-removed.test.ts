import request from "supertest";
import { expect, test } from "vitest";
import app from "../src/app";

test("endpoint auth lama /api/auth/login sudah dihapus → 404", async () => {
  const res = await request(app).post("/api/auth/login").send({ email: "a@b.c", password: "x" });
  expect(res.status).toBe(404);
});

test("router menu lama /api/menus sudah dihapus → 404 (F04 D17)", async () => {
  expect((await request(app).get("/api/menus")).status).toBe(404);
  expect((await request(app).delete("/api/menus/1").set("Authorization", "Bearer x")).status).toBe(404);
});
