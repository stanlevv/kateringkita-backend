import request from "supertest";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { migrate } from "../src/db/migrate";
import { loginLimiter, passwordLimiter } from "../src/auth/rateLimit";
import { resetTestDatabase } from "./helpers/db";

let tokenA: string;
let tokenB: string;

const login = (password = "rahasia123") =>
  request(app).post("/api/v1/auth/login").send({ identifier: "budi@mail.com", password, client: "web" });
const change = (body: object, token?: string) => {
  const r = request(app).put("/api/v1/me/password").send(body);
  return token ? r.set("Authorization", `Bearer ${token}`) : r;
};
const me = (token: string) => request(app).get("/api/v1/me").set("Authorization", `Bearer ${token}`);
const wrong = { current_password: "salahsalah1", new_password: "baru12345" };

beforeEach(async () => {
  await migrate(await resetTestDatabase());
  loginLimiter.reset();
  passwordLimiter.reset();
  await request(app)
    .post("/api/v1/auth/customer/register")
    .send({ full_name: "Budi", email: "budi@mail.com", phone: "081234567890", password: "rahasia123" })
    .expect(201);
  tokenA = (await login()).body.data.token;
  tokenB = (await login()).body.data.token;
});

test("kata sandi lama salah -> 400 fields.current_password", async () => {
  const res = await change(wrong, tokenA);
  expect(res.status).toBe(400);
  expect(res.body.error.fields.current_password).toBeDefined();
});

test("percobaan salah ke-6 -> 429 RATE_LIMITED", async () => {
  for (let i = 0; i < 5; i++) await change(wrong, tokenA).expect(400);
  const res = await change(wrong, tokenA);
  expect(res.status).toBe(429);
  expect(res.body.error.code).toBe("RATE_LIMITED");
});

test("8 percobaan salah paralel -> tepat 5x 400 dan 3x 429", async () => {
  const rs = await Promise.all(Array.from({ length: 8 }, () => change(wrong, tokenA)));
  expect(rs.filter((r) => r.status === 400)).toHaveLength(5);
  expect(rs.filter((r) => r.status === 429)).toHaveLength(3);
});

test("sandi baru tidak valid tidak memakan jatah", async () => {
  for (let i = 0; i < 5; i++) {
    await change({ current_password: "rahasia123", new_password: "abc" }, tokenA).expect(400);
  }
  await change({ current_password: "rahasia123", new_password: "baru12345" }, tokenA).expect(204);
});

test("new_password tanpa angka -> 400 fields.new_password", async () => {
  const res = await change({ current_password: "rahasia123", new_password: "abcdefgh" }, tokenA);
  expect(res.status).toBe(400);
  expect(res.body.error.fields.new_password).toBeDefined();
});

test("sukses -> 204, sesi lain dicabut, sesi ini hidup, sandi berganti", async () => {
  const res = await change({ current_password: "rahasia123", new_password: "baru12345" }, tokenA);
  expect(res.status).toBe(204);
  expect(res.text).toBe("");
  await me(tokenA).expect(200);
  await me(tokenB).expect(401);
  await login("rahasia123").expect(401);
  await login("baru12345").expect(200);
});

test("tanpa token -> 401", async () => {
  await change(wrong).expect(401);
});

afterEach(() => vi.restoreAllMocks());

test("UPDATE hash gagal -> 500, sesi lain sudah dicabut, sandi lama tetap berlaku", async () => {
  const orig = db.query.bind(db) as (...a: unknown[]) => Promise<unknown>;
  vi.spyOn(db, "query").mockImplementation(((sql: unknown, ...rest: unknown[]) =>
    typeof sql === "string" && sql.startsWith("UPDATE users SET password_hash")
      ? Promise.reject(new Error("gagal"))
      : orig(sql, ...rest)) as never);
  const res = await change({ current_password: "rahasia123", new_password: "baru12345" }, tokenA);
  expect(res.status).toBe(500);
  vi.restoreAllMocks();
  await me(tokenB).expect(401);
  await login("rahasia123").expect(200);
});
