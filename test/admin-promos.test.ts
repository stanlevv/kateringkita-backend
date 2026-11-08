import request from "supertest";
import { beforeAll, expect, test } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { migrate } from "../src/scripts/migrate";
import { createAdmin } from "../src/scripts/create-admin";
import { loginLimiter } from "../src/middleware/rateLimiter";
import { resetTestDatabase } from "./helpers/db";

let token: string;
let tokoPromoId: number;
const A = () => ({ Authorization: `Bearer ${token}` });
const get = (u: string) => request(app).get(`/api/v1/admin${u}`).set(A());
const post = (u: string, b: object = {}) => request(app).post(`/api/v1/admin${u}`).set(A()).send(b);
const patch = (u: string, b: object = {}) => request(app).patch(`/api/v1/admin${u}`).set(A()).send(b);
const put = (u: string, b: object = {}) => request(app).put(`/api/v1/admin${u}`).set(A()).send(b);
const logs = async (like: string) => (await db.query<any[]>("SELECT * FROM admin_audit_logs WHERE action LIKE ? ORDER BY id", [like]))[0] as any[];

const valid = {
  code: " hemat10 ", description: "Diskon", type: "percent", value: 10, max_discount: 5000,
  min_subtotal: 20000, quota: 100, per_user_limit: 1,
  starts_at: "2030-01-01T00:00:00.000Z", ends_at: "2030-02-01T00:00:00.000Z",
};

beforeAll(async () => {
  await migrate(await resetTestDatabase());
  loginLimiter.reset();
  await createAdmin({ phone: "081300000009", fullName: "Admin Uji", password: "rahasia123" });
  token = (await request(app).post("/api/v1/auth/login").send({ identifier: "081300000009", password: "rahasia123", client: "web" })).body.data.token;
  await request(app).post("/api/v1/auth/merchant/register").send({
    full_name: "Siti", email: "siti@mail.com", phone: "081298765432", password: "rahasia123",
    business_name: "Dapur Siti", merchant_type_id: 1, address: "Jl. Mawar 1",
  }).expect(201);
  const [m] = await db.query<any[]>("SELECT id FROM merchants LIMIT 1");
  const [ins] = await db.query<any>(
    "INSERT INTO promos (merchant_id, code, type, value, starts_at, ends_at) VALUES (?, 'TOKO1', 'fixed', 1000, '2030-01-01', '2030-02-01')", [m[0].id]);
  tokoPromoId = ins.insertId;
});

test("buat promo platform: kode kapital, log create", async () => {
  const r = await post("/promos", valid).expect(201);
  expect(r.body.data).toMatchObject({ code: "HEMAT10", merchant_id: null, type: "percent", value: 10, max_discount: 5000, used_count: 0, quota: 100 });
  expect(Boolean(r.body.data.is_active)).toBe(true);
  const l = await logs("promo.create");
  expect(l).toHaveLength(1);
  expect(l[0].target_id).toBe(String(r.body.data.id));
});

test("kode ganda (juga milik toko) → 409 fields.code", async () => {
  const r = await post("/promos", { ...valid, code: "hemat10" }).expect(409);
  expect(r.body.error.fields.code).toEqual(["Kode sudah dipakai."]);
  const r2 = await post("/promos", { ...valid, code: "TOKO1" }).expect(409);
  expect(r2.body.error.fields.code).toEqual(["Kode sudah dipakai."]);
});

test("validasi", async () => {
  const bad = async (o: object, f: string) => { const r = await post("/promos", { ...valid, code: "ZZZ99", ...o }); expect([f, r.status, Object.keys(r.body.error?.fields ?? {})]).toEqual([f, 400, expect.arrayContaining([f])]); };
  await bad({ code: "a!" }, "code");
  await bad({ type: "x" }, "type");
  await bad({ value: 101 }, "value");
  await bad({ value: 0 }, "value");
  await bad({ value: 1.5 }, "value");
  await bad({ max_discount: 0 }, "max_discount");
  await bad({ min_subtotal: -1 }, "min_subtotal");
  await bad({ quota: 0 }, "quota");
  await bad({ per_user_limit: 0 }, "per_user_limit");
  await bad({ starts_at: "bukan" }, "starts_at");
  await bad({ starts_at: "1" }, "starts_at");
  await bad({ starts_at: "March 7" }, "starts_at");
  await bad({ starts_at: "2030-01-01T00:00:00" }, "starts_at");
  await bad({ ends_at: "2030-02-01" }, "ends_at");
  await bad({ ends_at: valid.starts_at }, "ends_at");
  await bad({ description: "x".repeat(256) }, "description");
});

test("free_service_fee: value 0, max_discount null; fixed: max_discount null", async () => {
  const a = await post("/promos", { ...valid, code: "GRATIS", type: "free_service_fee", value: 5 }).expect(201);
  expect(a.body.data).toMatchObject({ value: 0, max_discount: null });
  const b = await post("/promos", { ...valid, code: "POTONG", type: "fixed", value: 3000 }).expect(201);
  expect(b.body.data).toMatchObject({ value: 3000, max_discount: null });
});

test("daftar hanya promo platform", async () => {
  const r = await get("/promos").expect(200);
  expect(r.body.data.map((p: any) => p.code).sort()).toEqual(["GRATIS", "HEMAT10", "POTONG"]);
  expect(r.body.data.every((p: any) => p.merchant_id === null)).toBe(true);
});

test("promo toko tak terjangkau → 404", async () => {
  await patch(`/promos/${tokoPromoId}`, valid).expect(404);
  await post(`/promos/${tokoPromoId}/deactivate`).expect(404);
  await post(`/promos/abc/activate`).expect(404);
});

test("ubah: kuota < used_count 400, log before/after, tanpa perubahan tanpa log", async () => {
  const id = (await get("/promos")).body.data.find((p: any) => p.code === "HEMAT10").id;
  await db.query("UPDATE promos SET used_count = 50 WHERE id=?", [id]);
  const r = await patch(`/promos/${id}`, { ...valid, quota: 10 }).expect(400);
  expect(r.body.error.fields.quota).toBeTruthy();
  const n0 = (await logs("promo.update")).length;
  await patch(`/promos/${id}`, { ...valid, quota: 100 }).expect(200);
  expect(await logs("promo.update")).toHaveLength(n0);
  const u = await patch(`/promos/${id}`, { value: 15, is_active: false, code: "HACK" }).expect(200);
  expect(u.body.data).toMatchObject({ value: 15, code: "HEMAT10" });
  expect(Boolean(u.body.data.is_active)).toBe(true);
  const l = await logs("promo.update");
  expect(l).toHaveLength(n0 + 1);
  expect(l[n0].before_json.value).toBe(10);
  expect(l[n0].after_json.value).toBe(15);
});

test("nonaktif/aktif: log, idempoten tanpa log", async () => {
  const id = (await get("/promos")).body.data.find((p: any) => p.code === "POTONG").id;
  await post(`/promos/${id}/deactivate`).expect(200);
  await post(`/promos/${id}/deactivate`).expect(200);
  expect(await logs("promo.deactivate")).toHaveLength(1);
  const r = await post(`/promos/${id}/activate`).expect(200);
  expect(Boolean(r.body.data.is_active)).toBe(true);
  expect(await logs("promo.activate")).toHaveLength(1);
});

test("biaya layanan", async () => {
  expect((await get("/settings").expect(200)).body.data).toEqual({ service_fee: 0, cs_whatsapp: null });
  await put("/settings/service-fee", { value: -1 }).expect(400);
  await put("/settings/service-fee", { value: 1.5 }).expect(400);
  await put("/settings/service-fee", { value: 100001 }).expect(400);
  await put("/settings/service-fee", { value: "2000" }).expect(400);
  await put("/settings/service-fee", { value: 2000 }).expect(200);
  expect((await get("/settings")).body.data).toEqual({ service_fee: 2000, cs_whatsapp: null });
  const [row] = await db.query<any[]>("SELECT setting_value FROM app_settings WHERE setting_key='service_fee'");
  expect(row[0].setting_value).toBe("2000");
  await put("/settings/service-fee", { value: 2000 }).expect(200);
  const l = await logs("settings.service_fee");
  expect(l).toHaveLength(1);
  expect(l[0].before_json).toEqual({ value: 0 });
  expect(l[0].after_json).toEqual({ value: 2000 });
});

test("log: filter admin, action, target, tanggal; nilai tak valid 400", async () => {
  const all = (await get("/audit-logs?limit=100").expect(200)).body;
  expect(all.data[0].admin_name).toBe("Admin Uji");
  const byAction = (await get("/audit-logs?action=promo.create").expect(200)).body;
  expect(byAction.meta.total).toBe(3);
  const byT = (await get("/audit-logs?target_type=settings").expect(200)).body;
  expect(byT.data.every((x: any) => x.target_type === "settings")).toBe(true);
  expect((await get("/audit-logs?target_type=promo&target_id=999").expect(200)).body.data).toEqual([]);
  expect((await get("/audit-logs?admin=1").expect(200)).body.meta.total).toBe(all.meta.total);
  expect((await get("/audit-logs?admin=999").expect(200)).body.data).toEqual([]);
  const today = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
  expect((await get(`/audit-logs?from=${today}&to=${today}`).expect(200)).body.meta.total).toBe(all.meta.total);
  expect((await get("/audit-logs?from=2000-01-01&to=2000-01-02").expect(200)).body.data).toEqual([]);
  await get("/audit-logs?from=kemarin").expect(400);
  await get("/audit-logs?to=2024-13-45").expect(400);
  await get("/audit-logs?admin=abc").expect(400);
  await get("/audit-logs?action=" + "x".repeat(61)).expect(400);
});

test("waktu dengan offset +07:00 tersimpan sebagai instan UTC yang benar", async () => {
  const r = await post("/promos", { ...valid, code: "WIB07", starts_at: "2030-03-01T07:00:00+07:00", ends_at: "2030-03-02T07:00:00+07:00" }).expect(201);
  expect(new Date(r.body.data.starts_at).toISOString()).toBe("2030-03-01T00:00:00.000Z");
  const [row] = await db.query<any[]>("SELECT DATE_FORMAT(starts_at, '%Y-%m-%d %H:%i:%s') s FROM promos WHERE code='WIB07'");
  expect(row[0].s).toBe("2030-03-01 00:00:00");
});

test("kode kosong dilaporkan bersama galat lain dalam satu 400", async () => {
  const { code: _c, ...tanpaKode } = valid;
  const r = await post("/promos", { ...tanpaKode, value: 0, quota: 0 }).expect(400);
  expect(Object.keys(r.body.error.fields).sort()).toEqual(["code", "quota", "value"]);
  expect(r.body.error.fields.code).toEqual(["Kode wajib diisi."]);
});
