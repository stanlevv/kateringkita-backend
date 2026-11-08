import request from "supertest";
import { beforeAll, expect, test, vi } from "vitest";
import * as audit from "../src/services/admin-audit.service";
import app from "../src/app";
import db from "../src/config/db";
import { migrate } from "../src/scripts/migrate";
import { createAdmin } from "../src/scripts/create-admin";
import { loginLimiter } from "../src/middleware/rateLimiter";
import { resetTestDatabase } from "./helpers/db";

let adminToken: string;
let sitiId: number;
let andiId: number;
const A = () => ({ Authorization: `Bearer ${adminToken}` });
const get = (u: string) => request(app).get(`/api/v1/admin${u}`).set(A());
const post = (u: string, b: object = {}) => request(app).post(`/api/v1/admin${u}`).set(A()).send(b);
const logCount = async () => Number(((await db.query<any[]>("SELECT COUNT(*) n FROM admin_audit_logs"))[0] as any[])[0].n);
const merchantRow = async (id: number) => ((await db.query<any[]>("SELECT * FROM merchants WHERE id=?", [id]))[0] as any[])[0];

const register = (name: string, phone: string, email: string) =>
  request(app).post("/api/v1/auth/merchant/register").send({
    full_name: name, email, phone, password: "rahasia123",
    business_name: `Dapur ${name}`, merchant_type_id: 1, address: "Jl. Mawar 1",
  }).expect(201);

beforeAll(async () => {
  await migrate(await resetTestDatabase());
  loginLimiter.reset();
  await createAdmin({ phone: "081300000009", fullName: "Admin Uji", password: "rahasia123" });
  await register("Siti", "081298765432", "siti@mail.com");
  await register("Andi", "081211112222", "andi@mail.com");
  adminToken = (await request(app).post("/api/v1/auth/login").send({ identifier: "081300000009", password: "rahasia123", client: "web" })).body.data.token;
  const [rows] = await db.query<any[]>("SELECT id FROM merchants ORDER BY id");
  sitiId = rows[0].id;
  andiId = rows[1].id;
});

test("checklist penjual baru: tanpa menu & titik temu", async () => {
  const r = await get(`/merchants/${sitiId}`).expect(200);
  expect(r.body.data.checklist).toMatchObject({ active_menu: false, pickup_point: false, menu_with_photo: false, address: true });
  expect(typeof r.body.data.checklist.wa_valid).toBe("boolean");
  expect(r.body.data.owner).toMatchObject({ full_name: "Siti", phone: "081298765432", email: "siti@mail.com" });
  expect(r.body.data.recent_logs).toEqual([]);
});

test("checklist terisi setelah ada menu berfoto & titik temu; wa_valid regex", async () => {
  await db.query("INSERT INTO merchant_pickup_points (merchant_id, pickup_point_id) VALUES (?, 1)", [sitiId]);
  await db.query("INSERT INTO menus (merchant_id, category_id, name, image_url, price, hpp) VALUES (?, 1, 'Nasi', 'http://x/y.jpg', 10000, 5000)", [sitiId]);
  await db.query("UPDATE merchants SET wa_number='08123456789' WHERE id=?", [sitiId]);
  let c = (await get(`/merchants/${sitiId}`).expect(200)).body.data.checklist;
  expect(c).toEqual({ wa_valid: true, address: true, pickup_point: true, active_menu: true, menu_with_photo: true, opening_hours: true });
  await db.query("UPDATE merchants SET wa_number='+6281' WHERE id=?", [sitiId]);
  c = (await get(`/merchants/${sitiId}`).expect(200)).body.data.checklist;
  expect(c.wa_valid).toBe(false);
  await db.query("UPDATE merchants SET wa_number='08123456789' WHERE id=?", [sitiId]);
});

test("alur pending → request-fix → verify", async () => {
  const q0 = (await get("/verification-queue").expect(200)).body.data;
  expect(q0.map((m: any) => m.id)).toEqual([sitiId, andiId]);
  expect(q0[0].updated_after_note).toBe(false);

  const fix = await post(`/merchants/${sitiId}/request-fix`, { reason: "  Tambah foto menu  " }).expect(200);
  expect(fix.body.data).toMatchObject({ verification_status: "needs_fix", verification_note: "Tambah foto menu" });

  await new Promise((r) => setTimeout(r, 1100));
  await db.query("UPDATE merchants SET description='baru' WHERE id=?", [sitiId]);
  const q = (await get("/verification-queue").expect(200)).body.data;
  expect(q.find((m: any) => m.id === sitiId).updated_after_note).toBe(true);
  expect(q.find((m: any) => m.id === andiId).updated_after_note).toBe(false);

  const ok = await post(`/merchants/${sitiId}/verify`).expect(200);
  expect(ok.body.data.verification_status).toBe("verified");
  expect(ok.body.data.verification_note).toBeNull();
  expect((await merchantRow(sitiId)).verified_at).not.toBeNull();
  expect(ok.body.data.recent_logs.map((l: any) => l.action)).toEqual(["merchant.verify", "merchant.request_fix"]);
  expect(ok.body.data.recent_logs[0].admin_name).toBe("Admin Uji");
  expect((await get("/verification-queue")).body.data.map((m: any) => m.id)).toEqual([andiId]);
});

test("validasi reason → 400 fields.reason; tidak ada log", async () => {
  const n = await logCount();
  for (const reason of [undefined, "   ", "x".repeat(501)]) {
    const r = await post(`/merchants/${andiId}/request-fix`, reason === undefined ? {} : { reason }).expect(400);
    expect(r.body.error.fields.reason).toBeDefined();
  }
  await post(`/merchants/${andiId}/suspend`, {}).expect(400);
  expect(await logCount()).toBe(n);
});

test("transisi tidak sah → 409, tanpa log & tanpa perubahan (Review Focus 3)", async () => {
  const n = await logCount();
  const before = await merchantRow(andiId);
  const r = await post(`/merchants/${andiId}/reactivate`).expect(409);
  expect(r.body.error).toMatchObject({ code: "CONFLICT", message: "Status penjual sudah berubah." });
  expect(await logCount()).toBe(n);
  expect(await merchantRow(andiId)).toEqual(before);

  await post(`/merchants/${sitiId}/suspend`, { reason: "Melanggar aturan" }).expect(200);
  await post(`/merchants/${sitiId}/verify`).expect(409);
  await post(`/merchants/${sitiId}/request-fix`, { reason: "x" }).expect(409);
  expect(await logCount()).toBe(n + 1);
});

test("suspend mengisi kolom & reactivate mengosongkannya", async () => {
  const row = await merchantRow(sitiId);
  expect(row).toMatchObject({ verification_status: "suspended", suspended_reason: "Melanggar aturan", verified_at: null });
  expect(row.suspended_at).not.toBeNull();
  const r = await post(`/merchants/${sitiId}/reactivate`).expect(200);
  expect(r.body.data.verification_status).toBe("verified");
  const after = await merchantRow(sitiId);
  expect(after).toMatchObject({ suspended_at: null, suspended_reason: null });
  expect(after.verified_at).not.toBeNull();
});

test("404 untuk id tak ada", async () => {
  const n = await logCount();
  await get("/merchants/99999").expect(404);
  await post("/merchants/99999/verify").expect(404);
  await post("/merchants/abc/verify").expect(404);
  expect(await logCount()).toBe(n);
});

test("close-today → is_open 0 + log", async () => {
  const n = await logCount();
  const r = await post(`/merchants/${sitiId}/close-today`).expect(200);
  expect(r.body.data.is_open).toBe(false);
  expect((await merchantRow(sitiId)).is_open).toBe(0);
  expect(await logCount()).toBe(n + 1);
  expect(r.body.data.recent_logs[0].action).toBe("merchant.close_today");
});

test("daftar: filter status, q (nama/WA, wildcard di-escape), open, paginasi", async () => {
  let r = await get("/merchants?status=pending").expect(200);
  expect(r.body.data.map((m: any) => m.id)).toEqual([andiId]);
  expect(r.body.meta).toEqual({ page: 1, limit: 20, total: 1 });
  r = await get("/merchants").expect(200);
  expect(r.body.meta.total).toBe(2);
  expect(r.body.data.find((m: any) => m.id === sitiId)).toMatchObject({ owner_name: "Siti", menu_count: 1, verification_status: "verified" });
  expect((await get("/merchants?q=Dapur Siti")).body.data).toHaveLength(1);
  expect((await get("/merchants?q=08123456789")).body.data).toHaveLength(1);
  expect((await get("/merchants?q=%25")).body.data).toHaveLength(0);
  expect((await get("/merchants?open=0")).body.data.map((m: any) => m.id)).toEqual([sitiId]);
  expect((await get("/merchants?open=1")).body.data.map((m: any) => m.id)).toEqual([andiId]);
  r = await get("/merchants?limit=1&page=2").expect(200);
  expect(r.body.data).toHaveLength(1);
  expect(r.body.meta).toEqual({ page: 2, limit: 1, total: 2 });
  expect((await get("/merchants?limit=9999")).body.meta.limit).toBe(100);
  await get("/merchants?status=aneh").expect(400);
});

test("detail: alamat asli tetap ada & checklist.address benar", async () => {
  const d = (await get(`/merchants/${sitiId}`).expect(200)).body.data;
  expect(d.address).toBe("Jl. Mawar 1");
  expect(d.checklist.address).toBe(true);
  expect(d.is_open).toBe(false);
  expect((await get("/merchants")).body.data.find((m: any) => m.id === andiId).is_open).toBe(true);
});

test("aksi tanpa reason mengabaikan body; suspend 500 karakter utuh; recent_logs maks 10", async () => {
  await register("Dewi", "081233334444", "dewi@mail.com");
  const dewiId = ((await db.query<any[]>("SELECT id FROM merchants WHERE business_name='Dapur Dewi'"))[0] as any[])[0].id;
  await post(`/merchants/${dewiId}/verify`, { reason: "x".repeat(600) }).expect(200);
  const [logs] = await db.query<any[]>("SELECT reason FROM admin_audit_logs WHERE action='merchant.verify' AND target_id=?", [String(dewiId)]);
  expect(logs[0].reason).toBeNull();

  const long = "a".repeat(500);
  await post(`/merchants/${dewiId}/suspend`, { reason: long }).expect(200);
  expect((await merchantRow(dewiId)).suspended_reason).toBe(long);

  for (let i = 0; i < 5; i++) {
    await post(`/merchants/${dewiId}/reactivate`).expect(200);
    await post(`/merchants/${dewiId}/suspend`, { reason: "ulang" }).expect(200);
  }
  expect((await get(`/merchants/${dewiId}`)).body.data.recent_logs).toHaveLength(10);
});

test("q dengan _ dicocokkan apa adanya", async () => {
  expect((await get("/merchants?q=Dapur_Siti")).body.data).toHaveLength(0);
  expect((await get("/merchants?q=Dapur Siti")).body.data).toHaveLength(1);
});

test("detail: merchant_type_name dan menu_count", async () => {
  const d = (await get(`/merchants/${sitiId}`).expect(200)).body.data;
  expect(typeof d.merchant_type_name).toBe("string");
  expect(d.merchant_type_name.length).toBeGreaterThan(0);
  expect(d.menu_count).toBe((await get("/merchants")).body.data.find((m: any) => m.id === sitiId).menu_count);
  expect(d.menu_count).toBeGreaterThan(0);
});

test("/me penjual ditangguhkan mengembalikan suspended_reason", async () => {
  await register("Rina", "081255556666", "rina@mail.com");
  const id = (await db.query<any[]>("SELECT id FROM merchants WHERE business_name = 'Dapur Rina'"))[0][0].id;
  await post(`/merchants/${id}/suspend`, { reason: "Menu palsu" }).expect(200);
  const token = (await request(app).post("/api/v1/auth/login").send({ identifier: "rina@mail.com", password: "rahasia123", client: "web" }).expect(200)).body.data.token;
  const me = (await request(app).get("/api/v1/me").set("Authorization", `Bearer ${token}`).expect(200)).body.data;
  expect(me.merchant).toMatchObject({ verification_status: "suspended", suspended_reason: "Menu palsu" });
});

test("close-today hanya dari verified; sudah tutup → 200 tanpa log & tanpa ubah updated_at (review akhir A4)", async () => {
  const n = await logCount();
  const andi = await merchantRow(andiId);
  await post(`/merchants/${andiId}/close-today`).expect(409);
  expect(await merchantRow(andiId)).toEqual(andi);
  const siti = await merchantRow(sitiId);
  expect(siti.is_open).toBe(0);
  await new Promise((r) => setTimeout(r, 1100));
  const r = await post(`/merchants/${sitiId}/close-today`).expect(200);
  expect(r.body.data.is_open).toBe(false);
  expect((await merchantRow(sitiId)).updated_at).toEqual(siti.updated_at);
  expect(await logCount()).toBe(n);
});

test("id tidak valid pada aksi beralasan → 404 walau body kosong (review akhir A5)", async () => {
  await post("/merchants/abc/request-fix").expect(404);
  await post("/merchants/0/suspend").expect(404);
});

test("catat gagal setelah UPDATE → baris penjual tidak berubah (rollback) (review akhir A6)", async () => {
  const n = await logCount();
  const before = await merchantRow(andiId);
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const spy = vi.spyOn(audit, "catat").mockRejectedValueOnce(new Error("gagal tulis log"));
  await post(`/merchants/${andiId}/verify`).expect(500);
  spy.mockRestore();
  err.mockRestore();
  expect(await merchantRow(andiId)).toEqual(before);
  expect(await logCount()).toBe(n);
});

// TiDB memakai utf8mb4_bin secara bawaan: pencarian harus tetap tak peka huruf (test terakhir: mengubah skema file ini)
test("q tak peka huruf walau kolom berkolasi biner", async () => {
  await db.query("ALTER TABLE merchants MODIFY business_name VARCHAR(150) NOT NULL COLLATE utf8mb4_bin");
  expect((await get("/merchants?q=dapur%20siti").expect(200)).body.data.map((m: any) => m.id)).toEqual([sitiId]);
});
