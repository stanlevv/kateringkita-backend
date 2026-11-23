import request from "supertest";
import { beforeAll, describe, expect, test } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { migrate } from "../src/scripts/migrate";
import { createAdmin } from "../src/scripts/create-admin";
import { loginLimiter } from "../src/middleware/rate-limiter";
import { canAccess } from "../src/middleware/admin-access";
import { resetTestDatabase } from "./helpers/db";

const login = async (identifier: string, password: string) => {
  loginLimiter.reset();
  const res = await request(app).post("/api/v1/auth/login").send({ identifier, password, client: "web" }).expect(200);
  return res.body.data.token as string;
};
const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });

describe("canAccess (tingkat admin)", () => {
  test.each([
    ["super", "POST", "/admins", true],
    ["ops", "GET", "/admins", false],
    ["ops", "POST", "/merchants/1/suspend", true],
    ["ops", "GET", "/finance", false],
    ["ops", "POST", "/refunds/KK-1", false],
    ["ops", "GET", "/payouts/balances", false],
    ["ops", "GET", "/settings", true],
    ["ops", "PUT", "/settings/service-fee", false],
    ["support", "GET", "/merchants", true],
    ["support", "POST", "/reviews/1/hide", false],
    ["support", "GET", "/ai-usage", false],
    // tiket bantuan: semua tingkat boleh GET & POST /tickets…
    ["support", "GET", "/tickets", true],
    ["support", "POST", "/tickets/TK-20261113-7QPX/messages", true],
    ["support", "POST", "/tickets/TK-20261113-7QPX/close", true],
    ["support", "PATCH", "/tickets/TK-20261113-7QPX", false],
    ["support", "POST", "/tickets-arsip", false],
    ["support", "POST", "/broadcasts", false],
    ["ops", "POST", "/tickets/TK-20261113-7QPX/close", true],
    [null, "GET", "/merchants", false],
    [null, "POST", "/tickets/TK-20261113-7QPX/messages", false],
    // Express mencocokkan rute tanpa peduli huruf besar/kecil; penjagaan tingkat harus sama
    ["support", "GET", "/Admins", false],
    ["ops", "GET", "/ADMINS", false],
    ["ops", "GET", "/Payouts/balances", false],
    ["ops", "GET", "/Finance", false],
    ["ops", "POST", "/Refunds/KK-1", false],
    ["ops", "GET", "/AI-usage", false],
    ["ops", "PUT", "/Settings/service-fee", false],
    ["support", "POST", "/Broadcasts", false],
    ["support", "POST", "/Tickets/TK-20261113-7QPX/messages", true],
  ] as const)("%s %s %s → %s", (level, method, path, allowed) => {
    expect(canAccess(level, method, path)).toBe(allowed);
  });
});

describe("kelola admin", () => {
  let superId: number;
  let superToken: string;

  beforeAll(async () => {
    await migrate(await resetTestDatabase());
    superId = (await createAdmin({ phone: "081300000101", fullName: "Super Satu", password: "rahasia123" })).id;
    superToken = await login("081300000101", "rahasia123");
  });

  test("admin:create membuat admin super tanpa wajib ganti sandi", async () => {
    const res = await request(app).get("/api/v1/me").set(authHeader(superToken)).expect(200);
    expect(res.body.data.user).toMatchObject({ admin_level: "super", must_change_password: false });
  });

  test("buat admin ops → sandi sementara, wajib ganti, tercatat di audit", async () => {
    const res = await request(app)
      .post("/api/v1/admin/admins")
      .set(authHeader(superToken))
      .send({ full_name: "Ops Dua", phone: "081300000102", admin_level: "ops" })
      .expect(201);
    const { admin, temp_password } = res.body.data;
    expect(admin).toMatchObject({ admin_level: "ops", must_change_password: true, is_active: true });
    expect(temp_password).toMatch(/[A-Za-z]/);
    expect(temp_password).toMatch(/\d/);

    const token = await login("081300000102", temp_password);
    const blockedRes = await request(app).get("/api/v1/admin/summary").set(authHeader(token)).expect(403);
    expect(blockedRes.body.error.code).toBe("PASSWORD_CHANGE_REQUIRED");

    await request(app)
      .put("/api/v1/me/password")
      .set(authHeader(token))
      .send({ current_password: temp_password, new_password: "opsbaru123" })
      .expect(204);
    await request(app).get("/api/v1/admin/summary").set(authHeader(token)).expect(200);
    await request(app).get("/api/v1/admin/admins").set(authHeader(token)).expect(403); // ops bukan super

    const [log] = await db.query<any[]>(
      "SELECT action FROM admin_audit_logs WHERE target_type = 'admin' AND target_id = ?",
      [String(admin.id)],
    );
    expect(log.map((entry) => entry.action)).toContain("admin.create");
  });

  test("nomor sudah terdaftar → 409", async () => {
    await request(app)
      .post("/api/v1/admin/admins")
      .set(authHeader(superToken))
      .send({ full_name: "Kembar", phone: "081300000102", admin_level: "support" })
      .expect(409);
  });

  test("support hanya bisa baca", async () => {
    const res = await request(app)
      .post("/api/v1/admin/admins")
      .set(authHeader(superToken))
      .send({ full_name: "Support Tiga", phone: "081300000103", admin_level: "support" })
      .expect(201);
    const newToken = await login("081300000103", res.body.data.temp_password);
    await request(app)
      .put("/api/v1/me/password")
      .set(authHeader(newToken))
      .send({ current_password: res.body.data.temp_password, new_password: "support123" })
      .expect(204);
    await request(app).get("/api/v1/admin/merchants").set(authHeader(newToken)).expect(200);
    await request(app)
      .post("/api/v1/admin/broadcasts")
      .set(authHeader(newToken))
      .send({ audience: "all", title: "x", body: "y" })
      .expect(403);
    // huruf besar di path tetap kena penjagaan tingkat (rute Express tidak peka huruf)
    await request(app).get("/api/v1/admin/Admins").set(authHeader(newToken)).expect(403);
    await request(app).get("/api/v1/admin/Payouts/balances").set(authHeader(newToken)).expect(403);
  });

  test("tidak bisa mengubah akun sendiri; super terakhir tidak bisa diturunkan", async () => {
    await request(app).post(`/api/v1/admin/admins/${superId}/deactivate`).set(authHeader(superToken)).expect(409);
    await request(app)
      .patch(`/api/v1/admin/admins/${superId}/level`)
      .set(authHeader(superToken))
      .send({ admin_level: "ops" })
      .expect(409);

    const res = await request(app)
      .post("/api/v1/admin/admins")
      .set(authHeader(superToken))
      .send({ full_name: "Super Empat", phone: "081300000104", admin_level: "super" })
      .expect(201);
    const id4 = res.body.data.admin.id;
    // dua super aktif: yang lain boleh diturunkan, lalu super terakhir (diri sendiri) tetap terjaga
    await request(app)
      .patch(`/api/v1/admin/admins/${id4}/level`)
      .set(authHeader(superToken))
      .send({ admin_level: "ops" })
      .expect(200);
  });

  test("nonaktifkan admin mencabut sesinya; reset sandi memberi sandi sementara baru", async () => {
    const [rows] = await db.query<any[]>("SELECT id FROM users WHERE phone = '081300000102'");
    const opsId = rows[0].id;
    const tokenOps = await login("081300000102", "opsbaru123");

    await request(app).post(`/api/v1/admin/admins/${opsId}/deactivate`).set(authHeader(superToken)).expect(200);
    await request(app).get("/api/v1/admin/summary").set(authHeader(tokenOps)).expect(401);
    await request(app).post(`/api/v1/admin/admins/${opsId}/activate`).set(authHeader(superToken)).expect(200);
    await request(app).get("/api/v1/admin/summary").set(authHeader(tokenOps)).expect(401); // sesi lama tetap dicabut

    const res = await request(app)
      .post(`/api/v1/admin/admins/${opsId}/reset-password`)
      .set(authHeader(superToken))
      .expect(200);
    expect(res.body.data.admin.must_change_password).toBe(true);
    await login("081300000102", res.body.data.temp_password);
  });

  test("id bukan admin → 404", async () => {
    await request(app).post("/api/v1/admin/admins/999999/deactivate").set(authHeader(superToken)).expect(404);
  });
});
