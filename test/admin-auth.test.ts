import request from "supertest";
import bcrypt from "bcryptjs";
import { beforeAll, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { migrate } from "../src/scripts/migrate";
import { createAdmin } from "../src/scripts/create-admin";
import { catat } from "../src/services/admin-audit.service";
import { loginLimiter } from "../src/middleware/rateLimiter";
import { resetTestDatabase } from "./helpers/db";

const GENERIC = "Email/WA atau password salah.";
let adminId: number;
let adminToken: string;
let merchantToken: string;
let customerToken: string;

const login = (identifier: string, client: "web" | "mobile" = "web") =>
  request(app).post("/api/v1/auth/login").send({ identifier, password: "rahasia123", client });
const sessionCount = async () => {
  const [r] = await db.query<any[]>("SELECT COUNT(*) AS n FROM auth_sessions");
  return Number(r[0].n);
};

beforeAll(async () => {
  await migrate(await resetTestDatabase());
  loginLimiter.reset();
  adminId = (await createAdmin({ phone: "081300000009", fullName: "Admin Uji", password: "rahasia123" })).id;
  await request(app)
    .post("/api/v1/auth/customer/register")
    .send({ full_name: "Budi", email: "budi@mail.com", phone: "081234567890", password: "rahasia123" })
    .expect(201);
  await request(app)
    .post("/api/v1/auth/merchant/register")
    .send({
      full_name: "Siti", email: "siti@mail.com", phone: "081298765432", password: "rahasia123",
      business_name: "Dapur Siti", merchant_type_id: 1, address: "Jl. Mawar 1",
    })
    .expect(201);
  adminToken = (await login("081300000009")).body.data.token;
  merchantToken = (await login("siti@mail.com")).body.data.token;
  customerToken = (await login("budi@mail.com")).body.data.token;
});

test("admin web login → 200 role admin", async () => {
  const r = await login("081300000009").expect(200);
  expect(r.body.data.user.role).toBe("admin");
});

test("admin mobile → 401 generik, tanpa sesi baru", async () => {
  const before = await sessionCount();
  const r = await login("081300000009", "mobile").expect(401);
  expect(r.body.error).toMatchObject({ code: "UNAUTHENTICATED", message: GENERIC });
  expect(await sessionCount()).toBe(before);
});

test("penjual web tetap 200; /me berisi verification_status pending", async () => {
  await login("siti@mail.com").expect(200);
  const r = await request(app).get("/api/v1/me").set("Authorization", `Bearer ${merchantToken}`).expect(200);
  expect(r.body.data.merchant.verification_status).toBe("pending");
  expect(r.body.data.merchant.verification_note).toBeNull();
  expect(r.body.data.merchant.suspended_reason).toBeNull();
});

test("audit-logs: 401 tanpa token, 403 penjual & pembeli, 200 admin", async () => {
  const url = "/api/v1/admin/audit-logs";
  await request(app).get(url).expect(401);
  await request(app).get(url).set("Authorization", `Bearer ${merchantToken}`).expect(403);
  await request(app).get(url).set("Authorization", `Bearer ${customerToken}`).expect(403);
  const r = await request(app).get(url).set("Authorization", `Bearer ${adminToken}`).expect(200);
  expect(r.body.data).toEqual([]);
  expect(r.body.meta).toEqual({ page: 1, limit: 20, total: 0 });
});

test("path admin tak dikenal: 401 tanpa token, 403 penjual, 404 admin", async () => {
  const url = "/api/v1/admin/tidak-ada";
  await request(app).get(url).expect(401);
  await request(app).get(url).set("Authorization", `Bearer ${merchantToken}`).expect(403);
  await request(app).get(url).set("Authorization", `Bearer ${adminToken}`).expect(404);
});

test("limit dibatasi 100", async () => {
  const r = await request(app).get("/api/v1/admin/audit-logs?limit=9999").set("Authorization", `Bearer ${adminToken}`).expect(200);
  expect(r.body.meta.limit).toBe(100);
});

test("admin+mobile: satu bcrypt.compare, body sama dengan sandi salah", async () => {
  const spy = vi.spyOn(bcrypt, "compare");
  const bener = await login("081300000009", "mobile").expect(401);
  expect(spy).toHaveBeenCalledTimes(1);
  spy.mockClear();
  const salah = await request(app).post("/api/v1/auth/login").send({ identifier: "081300000009", password: "salahsalah1", client: "mobile" }).expect(401);
  expect(spy).toHaveBeenCalledTimes(1);
  expect(bener.body).toEqual(salah.body);
  spy.mockRestore();
});

test("catat tersimpan & terbaca sebagai objek; rollback tidak meninggalkan baris", async () => {
  const conn = await db.getConnection();
  await conn.beginTransaction();
  await catat(conn, { adminId, action: "uji.rollback", targetType: "merchant", targetId: 1, before: { a: 1 } });
  await conn.rollback();
  conn.release();
  let r = await request(app).get("/api/v1/admin/audit-logs").set("Authorization", `Bearer ${adminToken}`).expect(200);
  expect(r.body.data).toEqual([]);

  await catat(db, { adminId, action: "uji.simpan", targetType: "merchant", targetId: 7, reason: "alasan", before: { a: 1 }, after: { a: 2 } });
  r = await request(app).get("/api/v1/admin/audit-logs").set("Authorization", `Bearer ${adminToken}`).expect(200);
  expect(r.body.data).toHaveLength(1);
  expect(r.body.data[0]).toMatchObject({ admin_name: "Admin Uji", action: "uji.simpan", target_id: "7", reason: "alasan", before: { a: 1 }, after: { a: 2 } });
  expect(r.body.meta.total).toBe(1);
});

test("rute tulis admin: token penjual → 403 tanpa baris log (review akhir A6)", async () => {
  const [[{ n }]] = await db.query<any[]>("SELECT COUNT(*) AS n FROM admin_audit_logs");
  const [[m]] = await db.query<any[]>("SELECT id, verification_status FROM merchants LIMIT 1");
  await request(app).post(`/api/v1/admin/merchants/${m.id}/suspend`).set("Authorization", `Bearer ${merchantToken}`).send({ reason: "coba" }).expect(403);
  const [[after]] = await db.query<any[]>("SELECT COUNT(*) AS n FROM admin_audit_logs");
  expect(after.n).toBe(n);
  const [[m2]] = await db.query<any[]>("SELECT verification_status FROM merchants WHERE id = ?", [m.id]);
  expect(m2.verification_status).toBe(m.verification_status);
});
