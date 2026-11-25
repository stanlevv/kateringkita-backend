// Isi file: uji pengiriman push FCM ke perangkat pembeli yang sesinya aktif (sendPushToUser, F40).
import request from "supertest";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import {
  createDefaultTransport,
  otherFailureCodes,
  sendPushToUser,
  setPushTransport,
  type PushMessage,
} from "../src/services/push.service";
import { createCustomer, login, prepareMerchants } from "./helpers/merchant";

const URL = "/api/v1/me/push-token";
const message: PushMessage = { title: "Judul", body: "Isi", data: { type: "order_status", order_code: "KK-1" } };
let tokenA: string;
let tokenB: string;
let userA: number;
let userB: number;

const put = (auth: string, token: string) =>
  request(app).put(URL).set("Authorization", `Bearer ${auth}`).send({ token, platform: "android" }).expect(204);
const userId = async (email: string) =>
  ((await db.query<any[]>("SELECT id FROM users WHERE email = ?", [email]))[0] as any[])[0].id as number;
const count = async (token: string) =>
  ((await db.query<any[]>("SELECT 1 FROM push_tokens WHERE token = ?", [token]))[0] as any[]).length;

beforeAll(async () => {
  await prepareMerchants();
  tokenA = await createCustomer(1);
  tokenB = await createCustomer(2);
  userA = await userId("pembeli1@mail.com");
  userB = await userId("pembeli2@mail.com");
});
afterAll(() => setPushTransport(null));

test("hanya token sesi aktif yang dikirimi", async () => {
  const loggedOut = await login("pembeli1@mail.com");
  const expired = await login("pembeli1@mail.com");
  await put(tokenA, "act-1");
  await put(loggedOut, "act-out");
  await put(expired, "act-exp");
  await request(app).post("/api/v1/auth/logout").set("Authorization", `Bearer ${loggedOut}`).expect(204);
  await db.query(
    "UPDATE auth_sessions SET expires_at = UTC_TIMESTAMP() - INTERVAL 1 HOUR WHERE jti = (SELECT session_jti FROM push_tokens WHERE token = 'act-exp')",
  );
  const transport = vi.fn().mockResolvedValue({ invalidTokens: [] });
  setPushTransport(transport);
  await sendPushToUser(userA, message);
  expect(transport).toHaveBeenCalledWith(["act-1"], message);
});

test("token milik pembeli lain tidak ikut", async () => {
  await put(tokenB, "other-1");
  const transport = vi.fn().mockResolvedValue({ invalidTokens: [] });
  setPushTransport(transport);
  await sendPushToUser(userB, message);
  expect(transport).toHaveBeenCalledWith(["other-1"], message);
});

test("invalidTokens dari transport dihapus dari tabel", async () => {
  await put(await login("pembeli1@mail.com"), "bad-1"); // sesi lain: satu sesi hanya satu token
  setPushTransport(vi.fn().mockResolvedValue({ invalidTokens: ["bad-1"] }));
  await sendPushToUser(userA, message);
  expect(await count("bad-1")).toBe(0);
  expect(await count("act-1")).toBe(1);
});

test("transport melempar → sendPushToUser resolve, console.error dipanggil", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  setPushTransport(vi.fn().mockRejectedValue(new Error("fcm down")));
  await expect(sendPushToUser(userA, message)).resolves.toBeUndefined();
  expect(error).toHaveBeenCalled();
  error.mockRestore();
});

test("transport null → resolve tanpa query galat", async () => {
  setPushTransport(null);
  await expect(sendPushToUser(userA, message)).resolves.toBeUndefined();
});

test("service account rusak → transport mati, satu console.error tanpa isi kunci", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(createDefaultTransport('{"private_key": "RAHASIA-123"')).toBeNull();
  expect(createDefaultTransport("RAHASIA-123")).toBeNull();
  expect(error).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(error.mock.calls)).not.toContain("RAHASIA-123");
  error.mockRestore();
});

test("otherFailureCodes: kode berbeda selain token mati, tanpa duplikat", () => {
  const responses = [
    {},
    { error: { code: "messaging/registration-token-not-registered" } },
    { error: { code: "messaging/quota-exceeded" } },
    { error: { code: "messaging/quota-exceeded" } },
    { error: {} },
  ];
  expect(otherFailureCodes(responses)).toEqual(["messaging/quota-exceeded", "unknown"]);
  expect(otherFailureCodes([{}, { error: { code: "messaging/invalid-registration-token" } }])).toEqual([]);
});

test("galat database tidak mencatat objek galat (SQL berisi token)", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  setPushTransport(vi.fn().mockRejectedValue(Object.assign(new Error("boom"), { sql: "SELECT 'TOKEN-RAHASIA'" })));
  await sendPushToUser(userA, message);
  expect(JSON.stringify(error.mock.calls)).not.toContain("TOKEN-RAHASIA");
  error.mockRestore();
});
