// Isi file: uji endpoint token push perangkat pembeli (PUT/DELETE /api/v1/me/push-token, F40).
import request from "supertest";
import { beforeAll, expect, test } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { createAdmin } from "../src/scripts/create-admin";
import { createCustomer, login, prepareMerchants } from "./helpers/merchant";

const URL = "/api/v1/me/push-token";
let tokenA: string;
let tokenB: string;
let merchantToken: string;
let adminToken: string;

const put = (auth: string, body: object) => request(app).put(URL).set("Authorization", `Bearer ${auth}`).send(body);
const rows = async (token: string) =>
  (await db.query<any[]>("SELECT * FROM push_tokens WHERE token = ?", [token]))[0] as any[];

beforeAll(async () => {
  ({ tokenA: merchantToken } = await prepareMerchants());
  tokenA = await createCustomer(1);
  tokenB = await createCustomer(2);
  await createAdmin({ phone: "081300000009", fullName: "Admin Uji", password: "rahasia123" });
  adminToken = await login("081300000009");
});

test("PUT simpan token terikat sesi login → 204, baris berisi user_id, session_jti, platform", async () => {
  await put(tokenA, { token: "fcm-1", platform: "android" }).expect(204);
  const [row] = await rows("fcm-1");
  const [[session]] = (await db.query<any[]>("SELECT user_id FROM auth_sessions WHERE jti = ?", [
    row.session_jti,
  ])) as any;
  expect(row.platform).toBe("android");
  expect(session.user_id).toBe(row.user_id);
});

test("PUT token sama dua kali → tetap 1 baris (idempoten)", async () => {
  await put(tokenA, { token: "fcm-2", platform: "web" }).expect(204);
  await put(tokenA, { token: "fcm-2", platform: "web" }).expect(204);
  expect(await rows("fcm-2")).toHaveLength(1);
});

test("token sama didaftarkan akun lain → pindah ke akun dan sesi baru", async () => {
  await put(tokenA, { token: "fcm-3", platform: "android" }).expect(204);
  const [before] = await rows("fcm-3");
  await put(tokenB, { token: "fcm-3", platform: "android" }).expect(204);
  const [row] = await rows("fcm-3");
  expect(row.user_id).not.toBe(before.user_id);
  expect(row.session_jti).not.toBe(before.session_jti);
  const [[other]] = (await db.query<any[]>("SELECT id FROM users WHERE email = 'pembeli2@mail.com'")) as any;
  expect(row.user_id).toBe(other.id);
});

test("DELETE hapus token sesi ini saja; sesi lain akun yang sama tetap", async () => {
  const second = await login("pembeli1@mail.com");
  await put(tokenA, { token: "fcm-4a", platform: "android" }).expect(204);
  await put(second, { token: "fcm-4b", platform: "android" }).expect(204);
  await request(app).delete(URL).set("Authorization", `Bearer ${tokenA}`).expect(204);
  expect(await rows("fcm-4a")).toHaveLength(0);
  expect(await rows("fcm-4b")).toHaveLength(1);
});

test("token kosong / 513 karakter / platform 'ios' → 400 VALIDATION_ERROR", async () => {
  for (const [body, field] of [
    [{ token: "  ", platform: "web" }, "token"],
    [{ token: "x".repeat(513), platform: "web" }, "token"],
    [{ token: "ok", platform: "ios" }, "platform"],
  ] as const) {
    const res = await put(tokenA, body).expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.fields[field]).toBeDefined();
  }
});

test("penjual dan admin → 403; tanpa login → 401", async () => {
  const body = { token: "fcm-5", platform: "web" };
  await put(merchantToken, body).expect(403);
  await put(adminToken, body).expect(403);
  await request(app).put(URL).send(body).expect(401);
  await request(app).delete(URL).expect(401);
  await request(app).delete(URL).set("Authorization", `Bearer ${adminToken}`).expect(403);
});

test("satu sesi hanya memegang satu token; sesi lain akun yang sama tidak tersentuh", async () => {
  const second = await login("pembeli1@mail.com");
  await put(second, { token: "fcm-6-lain", platform: "android" }).expect(204);
  await put(tokenA, { token: "fcm-6a", platform: "android" }).expect(204);
  await put(tokenA, { token: "fcm-6b", platform: "android" }).expect(204);
  expect(await rows("fcm-6a")).toHaveLength(0);
  expect(await rows("fcm-6b")).toHaveLength(1);
  expect(await rows("fcm-6-lain")).toHaveLength(1);
});
