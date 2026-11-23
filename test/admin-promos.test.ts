import request from "supertest";
import { beforeAll, expect, test } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { migrate } from "../src/scripts/migrate";
import { createAdmin } from "../src/scripts/create-admin";
import { loginLimiter } from "../src/middleware/rate-limiter";
import { resetTestDatabase } from "./helpers/db";

let token: string;
let merchantPromoId: number;
const authHeader = () => ({ Authorization: `Bearer ${token}` });
const get = (path: string) => request(app).get(`/api/v1/admin${path}`).set(authHeader());
const post = (path: string, body: object = {}) =>
  request(app).post(`/api/v1/admin${path}`).set(authHeader()).send(body);
const patch = (path: string, body: object = {}) =>
  request(app).patch(`/api/v1/admin${path}`).set(authHeader()).send(body);
const put = (path: string, body: object = {}) => request(app).put(`/api/v1/admin${path}`).set(authHeader()).send(body);
const logs = async (like: string) =>
  (await db.query<any[]>("SELECT * FROM admin_audit_logs WHERE action LIKE ? ORDER BY id", [like]))[0] as any[];

const valid = {
  code: " hemat10 ",
  description: "Diskon",
  type: "percent",
  value: 10,
  max_discount: 5000,
  min_subtotal: 20000,
  quota: 100,
  per_user_limit: 1,
  starts_at: "2030-01-01T00:00:00.000Z",
  ends_at: "2030-02-01T00:00:00.000Z",
};

beforeAll(async () => {
  await migrate(await resetTestDatabase());
  loginLimiter.reset();
  await createAdmin({ phone: "081300000009", fullName: "Admin Uji", password: "rahasia123" });
  token = (
    await request(app)
      .post("/api/v1/auth/login")
      .send({ identifier: "081300000009", password: "rahasia123", client: "web" })
  ).body.data.token;
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
  const [merchant] = await db.query<any[]>("SELECT id FROM merchants LIMIT 1");
  const [ins] = await db.query<any>(
    "INSERT INTO promos (merchant_id, code, type, value, starts_at, ends_at) VALUES (?, 'TOKO1', 'fixed', 1000, '2030-01-01', '2030-02-01')",
    [merchant[0].id],
  );
  merchantPromoId = ins.insertId;
});

test("buat promo platform: kode kapital, log create", async () => {
  const res = await post("/promos", valid).expect(201);
  expect(res.body.data).toMatchObject({
    code: "HEMAT10",
    merchant_id: null,
    type: "percent",
    value: 10,
    max_discount: 5000,
    used_count: 0,
    quota: 100,
  });
  expect(Boolean(res.body.data.is_active)).toBe(true);
  const entries = await logs("promo.create");
  expect(entries).toHaveLength(1);
  expect(entries[0].target_id).toBe(String(res.body.data.id));
});

test("kode ganda (juga milik toko) → 409 fields.code", async () => {
  const res = await post("/promos", { ...valid, code: "hemat10" }).expect(409);
  expect(res.body.error.fields.code).toEqual(["Kode sudah dipakai."]);
  const resMerchantCode = await post("/promos", { ...valid, code: "TOKO1" }).expect(409);
  expect(resMerchantCode.body.error.fields.code).toEqual(["Kode sudah dipakai."]);
});

test("validasi", async () => {
  const bad = async (overrides: object, field: string) => {
    const res = await post("/promos", { ...valid, code: "ZZZ99", ...overrides });
    expect([field, res.status, Object.keys(res.body.error?.fields ?? {})]).toEqual([
      field,
      400,
      expect.arrayContaining([field]),
    ]);
  };
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
  const freeFeePromo = await post("/promos", { ...valid, code: "GRATIS", type: "free_service_fee", value: 5 }).expect(
    201,
  );
  expect(freeFeePromo.body.data).toMatchObject({ value: 0, max_discount: null });
  const fixedPromo = await post("/promos", { ...valid, code: "POTONG", type: "fixed", value: 3000 }).expect(201);
  expect(fixedPromo.body.data).toMatchObject({ value: 3000, max_discount: null });
});

test("daftar hanya promo platform", async () => {
  const res = await get("/promos").expect(200);
  expect(res.body.data.map((promo: any) => promo.code).sort()).toEqual(["GRATIS", "HEMAT10", "POTONG"]);
  expect(res.body.data.every((promo: any) => promo.merchant_id === null)).toBe(true);
});

test("promo toko tak terjangkau → 404", async () => {
  await patch(`/promos/${merchantPromoId}`, valid).expect(404);
  await post(`/promos/${merchantPromoId}/deactivate`).expect(404);
  await post(`/promos/abc/activate`).expect(404);
});

test("ubah: kuota < used_count 400, log before/after, tanpa perubahan tanpa log", async () => {
  const id = (await get("/promos")).body.data.find((promo: any) => promo.code === "HEMAT10").id;
  await db.query("UPDATE promos SET used_count = 50 WHERE id=?", [id]);
  const res = await patch(`/promos/${id}`, { ...valid, quota: 10 }).expect(400);
  expect(res.body.error.fields.quota).toBeTruthy();
  const logCountBefore = (await logs("promo.update")).length;
  await patch(`/promos/${id}`, { ...valid, quota: 100 }).expect(200);
  expect(await logs("promo.update")).toHaveLength(logCountBefore);
  const updated = await patch(`/promos/${id}`, { value: 15, is_active: false, code: "HACK" }).expect(200);
  expect(updated.body.data).toMatchObject({ value: 15, code: "HEMAT10" });
  expect(Boolean(updated.body.data.is_active)).toBe(true);
  const entries = await logs("promo.update");
  expect(entries).toHaveLength(logCountBefore + 1);
  expect(entries[logCountBefore].before_json.value).toBe(10);
  expect(entries[logCountBefore].after_json.value).toBe(15);
});

test("nonaktif/aktif: log, idempoten tanpa log", async () => {
  const id = (await get("/promos")).body.data.find((promo: any) => promo.code === "POTONG").id;
  await post(`/promos/${id}/deactivate`).expect(200);
  await post(`/promos/${id}/deactivate`).expect(200);
  expect(await logs("promo.deactivate")).toHaveLength(1);
  const res = await post(`/promos/${id}/activate`).expect(200);
  expect(Boolean(res.body.data.is_active)).toBe(true);
  expect(await logs("promo.activate")).toHaveLength(1);
});

test("biaya layanan", async () => {
  expect((await get("/settings").expect(200)).body.data).toEqual({
    service_fee: 0,
    cs_whatsapp: null,
    maintenance: { aktif: false, pesan: null },
  });
  await put("/settings/service-fee", { value: -1 }).expect(400);
  await put("/settings/service-fee", { value: 1.5 }).expect(400);
  await put("/settings/service-fee", { value: 100001 }).expect(400);
  await put("/settings/service-fee", { value: "2000" }).expect(400);
  await put("/settings/service-fee", { value: 2000 }).expect(200);
  expect((await get("/settings")).body.data).toEqual({
    service_fee: 2000,
    cs_whatsapp: null,
    maintenance: { aktif: false, pesan: null },
  });
  const [row] = await db.query<any[]>("SELECT setting_value FROM app_settings WHERE setting_key='service_fee'");
  expect(row[0].setting_value).toBe("2000");
  await put("/settings/service-fee", { value: 2000 }).expect(200);
  const entries = await logs("settings.service_fee");
  expect(entries).toHaveLength(1);
  expect(entries[0].before_json).toEqual({ value: 0 });
  expect(entries[0].after_json).toEqual({ value: 2000 });
});

test("log: filter admin, action, target, tanggal; nilai tak valid 400", async () => {
  const all = (await get("/audit-logs?limit=100").expect(200)).body;
  expect(all.data[0].admin_name).toBe("Admin Uji");
  const byAction = (await get("/audit-logs?action=promo.create").expect(200)).body;
  expect(byAction.meta.total).toBe(3);
  const byTargetType = (await get("/audit-logs?target_type=settings").expect(200)).body;
  expect(byTargetType.data.every((entry: any) => entry.target_type === "settings")).toBe(true);
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
  const res = await post("/promos", {
    ...valid,
    code: "WIB07",
    starts_at: "2030-03-01T07:00:00+07:00",
    ends_at: "2030-03-02T07:00:00+07:00",
  }).expect(201);
  expect(new Date(res.body.data.starts_at).toISOString()).toBe("2030-03-01T00:00:00.000Z");
  const [row] = await db.query<any[]>(
    "SELECT DATE_FORMAT(starts_at, '%Y-%m-%d %H:%i:%s') s FROM promos WHERE code='WIB07'",
  );
  expect(row[0].s).toBe("2030-03-01 00:00:00");
});

test("kode kosong dilaporkan bersama galat lain dalam satu 400", async () => {
  const { code: _code, ...withoutCode } = valid;
  const res = await post("/promos", { ...withoutCode, value: 0, quota: 0 }).expect(400);
  expect(Object.keys(res.body.error.fields).sort()).toEqual(["code", "quota", "value"]);
  expect(res.body.error.fields.code).toEqual(["Kode wajib diisi."]);
});
