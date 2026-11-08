import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { pembeliBaru, siapCheckout } from "./helpers/toko";

// F14: POST /orders/:code/reorder
let s: Awaited<ReturnType<typeof siapCheckout>>;
let kode: string;
const H = (t: string) => ({ Authorization: `Bearer ${t}` });
const lagi = (code = kode, t = s.tCust) => request(app).post(`/api/v1/orders/${code}/reorder`).set(H(t));

beforeAll(async () => {
  s = await siapCheckout();
  const r = await request(app).post("/api/v1/orders").set(H(s.tCust)).set("Idempotency-Key", randomUUID())
    .send({ items: [{ menu_id: s.menu, qty: 2, option_ids: [s.keju] }, { menu_id: s.menu2, qty: 1 }], pickup_point_id: 1, payment_method: "cod", note: "Pedas" })
    .expect(201);
  kode = r.body.data.code;
  await request(app).post(`/api/v1/orders/${kode}/cancel`).set(H(s.tCust)).expect(200);
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("pesan lagi", () => {
  test("request = isi pesanan lama (menu, qty, opsi, titik temu, catatan) + quote harga terkini", async () => {
    await db.query("UPDATE menus SET price = 16000 WHERE id = ?", [s.menu]);
    const r = await lagi().expect(200);
    expect(r.body.data.request).toEqual({
      items: [{ menu_id: s.menu, qty: 2, option_ids: [s.keju] }, { menu_id: s.menu2, qty: 1, option_ids: [] }],
      pickup_point_id: 1, note: "Pedas", promo_code: null, customer_name: null, customer_phone: null, pickup_at: null,
    });
    // (16000 + 3000) × 2 + 5000
    expect(r.body.data.quote).toMatchObject({ subtotal: 43000, total: 43000, warnings: [] });
    const baru = await request(app).post("/api/v1/orders").set(H(s.tCust)).set("Idempotency-Key", randomUUID())
      .send({ ...r.body.data.request, payment_method: "cod" }).expect(201);
    expect(baru.body.data.code).not.toBe(kode);
  });

  test("pesanan orang lain 404; menu sudah nonaktif → 400 per baris", async () => {
    await lagi(kode, await pembeliBaru(1)).expect(404);
    await db.query("UPDATE menus SET is_active = FALSE WHERE id = ?", [s.menu2]);
    expect((await lagi().expect(400)).body.error.fields).toEqual({ "items.1.menu_id": ["Menu tidak tersedia."] });
  });
});
