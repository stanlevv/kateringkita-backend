import request from "supertest";
import { beforeAll, expect, test, vi } from "vitest";
import * as audit from "../src/services/admin-audit.service";
import app from "../src/app";
import db from "../src/config/db";
import { migrate } from "../src/scripts/migrate";
import { createAdmin } from "../src/scripts/create-admin";
import { loginLimiter } from "../src/middleware/rate-limiter";
import { resetTestDatabase } from "./helpers/db";

let adminToken: string;
let sitiId: number;
let andiId: number;
const authHeader = () => ({ Authorization: `Bearer ${adminToken}` });
const get = (path: string) => request(app).get(`/api/v1/admin${path}`).set(authHeader());
const post = (path: string, body: object = {}) =>
  request(app).post(`/api/v1/admin${path}`).set(authHeader()).send(body);
const logCount = async () =>
  Number(((await db.query<any[]>("SELECT COUNT(*) n FROM admin_audit_logs"))[0] as any[])[0].n);
const merchantRow = async (id: number) =>
  ((await db.query<any[]>("SELECT * FROM merchants WHERE id=?", [id]))[0] as any[])[0];

const register = (name: string, phone: string, email: string) =>
  request(app)
    .post("/api/v1/auth/merchant/register")
    .send({
      full_name: name,
      email,
      phone,
      password: "rahasia123",
      business_name: `Dapur ${name}`,
      merchant_type_id: 1,
      address: "Jl. Mawar 1",
    })
    .expect(201);

beforeAll(async () => {
  await migrate(await resetTestDatabase());
  loginLimiter.reset();
  await createAdmin({ phone: "081300000009", fullName: "Admin Uji", password: "rahasia123" });
  await register("Siti", "081298765432", "siti@mail.com");
  await register("Andi", "081211112222", "andi@mail.com");
  adminToken = (
    await request(app)
      .post("/api/v1/auth/login")
      .send({ identifier: "081300000009", password: "rahasia123", client: "web" })
  ).body.data.token;
  const [rows] = await db.query<any[]>("SELECT id FROM merchants ORDER BY id");
  sitiId = rows[0].id;
  andiId = rows[1].id;
});

test("checklist penjual baru: tanpa menu & titik temu", async () => {
  const res = await get(`/merchants/${sitiId}`).expect(200);
  expect(res.body.data.checklist).toMatchObject({
    active_menu: false,
    pickup_point: false,
    menu_with_photo: false,
    address: true,
  });
  expect(typeof res.body.data.checklist.wa_valid).toBe("boolean");
  expect(res.body.data.owner).toMatchObject({ full_name: "Siti", phone: "081298765432", email: "siti@mail.com" });
  expect(res.body.data.recent_logs).toEqual([]);
});

test("checklist terisi setelah ada menu berfoto & titik temu; wa_valid regex", async () => {
  await db.query("INSERT INTO merchant_pickup_points (merchant_id, pickup_point_id) VALUES (?, 1)", [sitiId]);
  await db.query(
    "INSERT INTO menus (merchant_id, category_id, name, image_url, price, hpp) VALUES (?, 1, 'Nasi', 'http://x/y.jpg', 10000, 5000)",
    [sitiId],
  );
  await db.query("UPDATE merchants SET wa_number='08123456789' WHERE id=?", [sitiId]);
  let checklist = (await get(`/merchants/${sitiId}`).expect(200)).body.data.checklist;
  expect(checklist).toEqual({
    wa_valid: true,
    address: true,
    pickup_point: true,
    active_menu: true,
    menu_with_photo: true,
    opening_hours: true,
  });
  await db.query("UPDATE merchants SET wa_number='+6281' WHERE id=?", [sitiId]);
  checklist = (await get(`/merchants/${sitiId}`).expect(200)).body.data.checklist;
  expect(checklist.wa_valid).toBe(false);
  await db.query("UPDATE merchants SET wa_number='08123456789' WHERE id=?", [sitiId]);
});

test("alur pending → request-fix → verify", async () => {
  const queueBefore = (await get("/verification-queue").expect(200)).body.data;
  expect(queueBefore.map((merchant: any) => merchant.id)).toEqual([sitiId, andiId]);
  expect(queueBefore[0].updated_after_note).toBe(false);

  const fix = await post(`/merchants/${sitiId}/request-fix`, { reason: "  Tambah foto menu  " }).expect(200);
  expect(fix.body.data).toMatchObject({ verification_status: "needs_fix", verification_note: "Tambah foto menu" });

  await new Promise((resolve) => setTimeout(resolve, 1100));
  await db.query("UPDATE merchants SET description='baru' WHERE id=?", [sitiId]);
  const queue = (await get("/verification-queue").expect(200)).body.data;
  expect(queue.find((merchant: any) => merchant.id === sitiId).updated_after_note).toBe(true);
  expect(queue.find((merchant: any) => merchant.id === andiId).updated_after_note).toBe(false);

  const verified = await post(`/merchants/${sitiId}/verify`).expect(200);
  expect(verified.body.data.verification_status).toBe("verified");
  expect(verified.body.data.verification_note).toBeNull();
  expect((await merchantRow(sitiId)).verified_at).not.toBeNull();
  expect(verified.body.data.recent_logs.map((log: any) => log.action)).toEqual([
    "merchant.verify",
    "merchant.request_fix",
  ]);
  expect(verified.body.data.recent_logs[0].admin_name).toBe("Admin Uji");
  expect((await get("/verification-queue")).body.data.map((merchant: any) => merchant.id)).toEqual([andiId]);
});

test("validasi reason → 400 fields.reason; tidak ada log", async () => {
  const logCountBefore = await logCount();
  for (const reason of [undefined, "   ", "x".repeat(501)]) {
    const res = await post(`/merchants/${andiId}/request-fix`, reason === undefined ? {} : { reason }).expect(400);
    expect(res.body.error.fields.reason).toBeDefined();
  }
  await post(`/merchants/${andiId}/suspend`, {}).expect(400);
  expect(await logCount()).toBe(logCountBefore);
});

test("transisi tidak sah → 409, tanpa log & tanpa perubahan (Review Focus 3)", async () => {
  const logCountBefore = await logCount();
  const before = await merchantRow(andiId);
  const res = await post(`/merchants/${andiId}/reactivate`).expect(409);
  expect(res.body.error).toMatchObject({ code: "CONFLICT", message: "Status penjual sudah berubah." });
  expect(await logCount()).toBe(logCountBefore);
  expect(await merchantRow(andiId)).toEqual(before);

  await post(`/merchants/${sitiId}/suspend`, { reason: "Melanggar aturan" }).expect(200);
  await post(`/merchants/${sitiId}/verify`).expect(409);
  await post(`/merchants/${sitiId}/request-fix`, { reason: "x" }).expect(409);
  expect(await logCount()).toBe(logCountBefore + 1);
});

test("suspend mengisi kolom & reactivate mengosongkannya", async () => {
  const row = await merchantRow(sitiId);
  expect(row).toMatchObject({
    verification_status: "suspended",
    suspended_reason: "Melanggar aturan",
    verified_at: null,
  });
  expect(row.suspended_at).not.toBeNull();
  const res = await post(`/merchants/${sitiId}/reactivate`).expect(200);
  expect(res.body.data.verification_status).toBe("verified");
  const after = await merchantRow(sitiId);
  expect(after).toMatchObject({ suspended_at: null, suspended_reason: null });
  expect(after.verified_at).not.toBeNull();
});

test("404 untuk id tak ada", async () => {
  const logCountBefore = await logCount();
  await get("/merchants/99999").expect(404);
  await post("/merchants/99999/verify").expect(404);
  await post("/merchants/abc/verify").expect(404);
  expect(await logCount()).toBe(logCountBefore);
});

test("close-today → is_open 0 + log", async () => {
  const logCountBefore = await logCount();
  const res = await post(`/merchants/${sitiId}/close-today`).expect(200);
  expect(res.body.data.is_open).toBe(false);
  expect((await merchantRow(sitiId)).is_open).toBe(0);
  expect(await logCount()).toBe(logCountBefore + 1);
  expect(res.body.data.recent_logs[0].action).toBe("merchant.close_today");
});

test("daftar: filter status, q (nama/WA, wildcard di-escape), open, paginasi", async () => {
  let res = await get("/merchants?status=pending").expect(200);
  expect(res.body.data.map((merchant: any) => merchant.id)).toEqual([andiId]);
  expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 1 });
  res = await get("/merchants").expect(200);
  expect(res.body.meta.total).toBe(2);
  expect(res.body.data.find((merchant: any) => merchant.id === sitiId)).toMatchObject({
    owner_name: "Siti",
    menu_count: 1,
    verification_status: "verified",
  });
  expect((await get("/merchants?q=Dapur Siti")).body.data).toHaveLength(1);
  expect((await get("/merchants?q=08123456789")).body.data).toHaveLength(1);
  expect((await get("/merchants?q=%25")).body.data).toHaveLength(0);
  expect((await get("/merchants?open=0")).body.data.map((merchant: any) => merchant.id)).toEqual([sitiId]);
  expect((await get("/merchants?open=1")).body.data.map((merchant: any) => merchant.id)).toEqual([andiId]);
  res = await get("/merchants?limit=1&page=2").expect(200);
  expect(res.body.data).toHaveLength(1);
  expect(res.body.meta).toEqual({ page: 2, limit: 1, total: 2 });
  expect((await get("/merchants?limit=9999")).body.meta.limit).toBe(100);
  await get("/merchants?status=aneh").expect(400);
});

test("detail: alamat asli tetap ada & checklist.address benar", async () => {
  const detail = (await get(`/merchants/${sitiId}`).expect(200)).body.data;
  expect(detail.address).toBe("Jl. Mawar 1");
  expect(detail.checklist.address).toBe(true);
  expect(detail.is_open).toBe(false);
  expect((await get("/merchants")).body.data.find((merchant: any) => merchant.id === andiId).is_open).toBe(true);
});

test("aksi tanpa reason mengabaikan body; suspend 500 karakter utuh; recent_logs maks 10", async () => {
  await register("Dewi", "081233334444", "dewi@mail.com");
  const dewiId = ((await db.query<any[]>("SELECT id FROM merchants WHERE business_name='Dapur Dewi'"))[0] as any[])[0]
    .id;
  await post(`/merchants/${dewiId}/verify`, { reason: "x".repeat(600) }).expect(200);
  const [logs] = await db.query<any[]>(
    "SELECT reason FROM admin_audit_logs WHERE action='merchant.verify' AND target_id=?",
    [String(dewiId)],
  );
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

// rekening pencairan hanya untuk admin super lewat /payouts; detail penjual terbuka untuk semua tier admin
test("detail penjual tidak membawa rekening pencairan", async () => {
  await db.query(
    "UPDATE merchants SET payout_bank = 'bca', payout_account_number = '0123456789', payout_account_name = 'Siti' WHERE id = ?",
    [sitiId],
  );
  const detail = (await get(`/merchants/${sitiId}`).expect(200)).body.data;
  expect(Object.keys(detail).filter((key) => key.startsWith("payout_"))).toEqual([]);
  expect(JSON.stringify(detail)).not.toContain("0123456789");
});

test("detail: merchant_type_name dan menu_count", async () => {
  const detail = (await get(`/merchants/${sitiId}`).expect(200)).body.data;
  expect(typeof detail.merchant_type_name).toBe("string");
  expect(detail.merchant_type_name.length).toBeGreaterThan(0);
  expect(detail.menu_count).toBe(
    (await get("/merchants")).body.data.find((merchant: any) => merchant.id === sitiId).menu_count,
  );
  expect(detail.menu_count).toBeGreaterThan(0);
});

test("/me penjual ditangguhkan mengembalikan suspended_reason", async () => {
  await register("Rina", "081255556666", "rina@mail.com");
  const id = (await db.query<any[]>("SELECT id FROM merchants WHERE business_name = 'Dapur Rina'"))[0][0].id;
  await post(`/merchants/${id}/suspend`, { reason: "Menu palsu" }).expect(200);
  const token = (
    await request(app)
      .post("/api/v1/auth/login")
      .send({ identifier: "rina@mail.com", password: "rahasia123", client: "web" })
      .expect(200)
  ).body.data.token;
  const profile = (await request(app).get("/api/v1/me").set("Authorization", `Bearer ${token}`).expect(200)).body.data;
  expect(profile.merchant).toMatchObject({ verification_status: "suspended", suspended_reason: "Menu palsu" });
});

test("close-today hanya dari verified; sudah tutup → 200 tanpa log & tanpa ubah updated_at (review akhir A4)", async () => {
  const logCountBefore = await logCount();
  const andi = await merchantRow(andiId);
  await post(`/merchants/${andiId}/close-today`).expect(409);
  expect(await merchantRow(andiId)).toEqual(andi);
  const siti = await merchantRow(sitiId);
  expect(siti.is_open).toBe(0);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const res = await post(`/merchants/${sitiId}/close-today`).expect(200);
  expect(res.body.data.is_open).toBe(false);
  expect((await merchantRow(sitiId)).updated_at).toEqual(siti.updated_at);
  expect(await logCount()).toBe(logCountBefore);
});

test("id tidak valid pada aksi beralasan → 404 walau body kosong (review akhir A5)", async () => {
  await post("/merchants/abc/request-fix").expect(404);
  await post("/merchants/0/suspend").expect(404);
});

test("catat gagal setelah UPDATE → baris penjual tidak berubah (rollback) (review akhir A6)", async () => {
  const logCountBefore = await logCount();
  const before = await merchantRow(andiId);
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const spy = vi.spyOn(audit, "recordAudit").mockRejectedValueOnce(new Error("gagal tulis log"));
  await post(`/merchants/${andiId}/verify`).expect(500);
  spy.mockRestore();
  err.mockRestore();
  expect(await merchantRow(andiId)).toEqual(before);
  expect(await logCount()).toBe(logCountBefore);
});

// TiDB memakai utf8mb4_bin secara bawaan: pencarian harus tetap tak peka huruf (test terakhir: mengubah skema file ini)
test("q tak peka huruf walau kolom berkolasi biner", async () => {
  await db.query("ALTER TABLE merchants MODIFY business_name VARCHAR(150) NOT NULL COLLATE utf8mb4_bin");
  expect((await get("/merchants?q=dapur%20siti").expect(200)).body.data.map((merchant: any) => merchant.id)).toEqual([
    sitiId,
  ]);
});
