import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { hariIniWib } from "../src/services/merchant-kuota.service";
import { createAdmin } from "../src/scripts/create-admin";
import { login, pesanDulu, siapCheckout } from "./helpers/toko";

// F20: GET /admin/finance — rekap pesanan completed per toko, diskon dipisah toko vs platform
let s: Awaited<ReturnType<typeof siapCheckout>>;
let tAdmin: string;
const H = (t: string) => ({ Authorization: `Bearer ${t}` });
const hariIni = hariIniWib();
const selesai = async (code: string) => {
  for (const a of ["confirm", "cook", "ready", "complete"]) await request(app).post(`/api/v1/merchant/orders/${code}/${a}`).set(H(s.tA)).expect(200);
};
const pesanPromo = async (promo_code: string) => (await request(app).post("/api/v1/orders").set(H(s.tCust)).set("Idempotency-Key", randomUUID())
  .send({ items: [{ menu_id: s.menu, qty: 1 }], pickup_point_id: 1, payment_method: "cod", promo_code }).expect(201)).body.data.code;

beforeAll(async () => {
  s = await siapCheckout();
  await createAdmin({ phone: "081300000009", fullName: "Admin Uji", password: "rahasia123" });
  tAdmin = await login("081300000009");
  await db.query("UPDATE app_settings SET setting_value = '1000' WHERE setting_key = 'service_fee'");
  await request(app).post("/api/v1/merchant/promos").set(H(s.tA)).send({
    code: "TOKO2K", type: "fixed", value: 2000, min_subtotal: 0, per_user_limit: 1, starts_at: "2020-01-01T00:00:00Z", ends_at: "2099-01-01T00:00:00Z",
  }).expect(201);
  await db.query(`INSERT INTO promos (merchant_id, code, type, value, min_subtotal, per_user_limit, starts_at, ends_at)
    VALUES (NULL, 'GRATIS', 'free_service_fee', 0, 0, 1, '2020-01-01', '2099-01-01')`);
  await selesai(await pesanPromo("TOKO2K"));
  await selesai(await pesanPromo("GRATIS"));
  await pesanDulu(s.tCust, s.menu); // holding: tidak dihitung
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("rekap keuangan", () => {
  test("per toko + total; diskon toko vs platform; hanya completed", async () => {
    const r = await request(app).get(`/api/v1/admin/finance?from=${hariIni}&to=${hariIni}`).set(H(tAdmin)).expect(200);
    const baris = { orders: 2, subtotal: 30000, discount_merchant: 2000, discount_platform: 1000, service_fee: 2000, total: 29000, merchant_net: 28000, platform_net: 1000 };
    expect(r.body.data).toEqual({ rows: [{ merchant_id: s.idA, business_name: "Dapur Siti", ...baris }], totals: baris });
  });

  test("rentang tanpa transaksi → kosong; validasi; hanya admin", async () => {
    const r = await request(app).get("/api/v1/admin/finance?from=2020-01-01&to=2020-01-31").set(H(tAdmin)).expect(200);
    expect(r.body.data).toEqual({ rows: [], totals: { orders: 0, subtotal: 0, discount_merchant: 0, discount_platform: 0, service_fee: 0, total: 0, merchant_net: 0, platform_net: 0 } });
    expect((await request(app).get("/api/v1/admin/finance?from=2026-01-01&to=2026-12-31").set(H(tAdmin)).expect(400)).body.error.fields.to)
      .toEqual(["Rentang maksimal 92 hari."]);
    await request(app).get(`/api/v1/admin/finance?from=${hariIni}&to=${hariIni}`).set(H(s.tA)).expect(403);
  });
});
