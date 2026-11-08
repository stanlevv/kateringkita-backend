import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, expect, test } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { migrate } from "../src/scripts/migrate";
import { loginLimiter } from "../src/middleware/rateLimiter";
import { resetTestDatabase } from "./helpers/db";

const GENERIC = "Email/WA atau password salah.";
let merchantToken: string;
let customerToken: string;

const login = (identifier: string) =>
  request(app).post("/api/v1/auth/login").send({ identifier, password: "rahasia123", client: "web" });
const me = (token?: string) => {
  const r = request(app).get("/api/v1/me");
  return token ? r.set("Authorization", `Bearer ${token}`) : r;
};

beforeEach(async () => {
  await migrate(await resetTestDatabase());
  loginLimiter.reset();
  await request(app)
    .post("/api/v1/auth/customer/register")
    .send({ full_name: "Budi", email: "budi@mail.com", phone: "081234567890", password: "rahasia123" })
    .expect(201);
  await request(app)
    .post("/api/v1/auth/merchant/register")
    .send({
      full_name: "Siti",
      email: "siti@mail.com",
      phone: "081298765432",
      password: "rahasia123",
      business_name: "Dapur Siti",
      merchant_type_id: 1,
      address: "Jl. Mawar 1",
    })
    .expect(201);
  customerToken = (await login("budi@mail.com")).body.data.token;
  merchantToken = (await login("siti@mail.com")).body.data.token;
});

test("/me tanpa header → 401 UNAUTHENTICATED", async () => {
  const res = await me();
  expect(res.status).toBe(401);
  expect(res.body.error.code).toBe("UNAUTHENTICATED");
});

test("/me token rusak → 401", async () => {
  expect((await me("abc")).status).toBe(401);
});

test("/me token ditandatangani secret lain → 401", async () => {
  const forged = jwt.sign({ sub: "1", role: "merchant" }, "x".repeat(40), { jwtid: "abc" });
  expect((await me(forged)).status).toBe(401);
});

test("/me merchant → user + merchant.slug", async () => {
  const res = await me(merchantToken);
  expect(res.status).toBe(200);
  expect(res.body.data.user.role).toBe("merchant");
  expect(res.body.data.user).not.toHaveProperty("password_hash");
  expect(res.body.data.merchant.slug).toMatch(/^dapur-siti-/);
});

test("/me customer → merchant null", async () => {
  const res = await me(customerToken);
  expect(res.status).toBe(200);
  expect(res.body.data.user.role).toBe("customer");
  expect(res.body.data.merchant).toBeNull();
});

test("logout → 204, token sama lalu ditolak", async () => {
  const out = await request(app).post("/api/v1/auth/logout").set("Authorization", `Bearer ${customerToken}`);
  expect(out.status).toBe(204);
  expect(out.text).toBe("");
  expect((await me(customerToken)).status).toBe(401);
});

test("logout tanpa token → 401", async () => {
  expect((await request(app).post("/api/v1/auth/logout")).status).toBe(401);
});

test("akun dinonaktifkan → token hidup ditolak, login ulang ditolak generik", async () => {
  await db.query("UPDATE users SET is_active = FALSE WHERE email = 'budi@mail.com'");
  expect((await me(customerToken)).status).toBe(401);
  const res = await login("budi@mail.com");
  expect(res.status).toBe(401);
  expect(res.body.error.message).toBe(GENERIC);
});

test("sesi kedaluwarsa → 401", async () => {
  await db.query("UPDATE auth_sessions SET expires_at = UTC_TIMESTAMP() - INTERVAL 1 MINUTE");
  expect((await me(customerToken)).status).toBe(401);
});

test("customer ke GET /api/v1/merchant/menus → 403 FORBIDDEN", async () => {
  const res = await request(app)
    .get("/api/v1/merchant/menus")
    .set("Authorization", `Bearer ${customerToken}`);
  expect(res.status).toBe(403);
  expect(res.body.error.code).toBe("FORBIDDEN");
});

test("JWT exp lewat (sesi DB masih hidup) → 401", async () => {
  const { sub, jti } = jwt.decode(customerToken) as { sub: string; jti: string };
  const expired = jwt.sign({ sub, role: "customer", exp: Math.floor(Date.now() / 1000) - 10 }, process.env.JWT_SECRET!, {
    jwtid: jti,
  });
  expect((await me(expired)).status).toBe(401);
  expect((await me(customerToken)).status).toBe(200);
});

test("merchant lolos requireRole di route menu penjual", async () => {
  const res = await request(app)
    .get("/api/v1/merchant/menus")
    .set("Authorization", `Bearer ${merchantToken}`);
  expect(res.status).toBe(200);
});

test("/me merchant: tidak ada password_hash di mana pun dalam body", async () => {
  const res = await me(merchantToken);
  expect(JSON.stringify(res.body)).not.toContain("password_hash");
});
