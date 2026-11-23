import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { createCustomer, prepareCheckout } from "./helpers/merchant";

// F14: POST /orders/:code/reorder
let setup: Awaited<ReturnType<typeof prepareCheckout>>;
let kode: string;
const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });
const lagi = (code = kode, token = setup.customerToken) =>
  request(app).post(`/api/v1/orders/${code}/reorder`).set(authHeader(token));

beforeAll(async () => {
  setup = await prepareCheckout();
  const res = await request(app)
    .post("/api/v1/orders")
    .set(authHeader(setup.customerToken))
    .set("Idempotency-Key", randomUUID())
    .send({
      items: [
        { menu_id: setup.menu, qty: 2, option_ids: [setup.keju] },
        { menu_id: setup.menu2, qty: 1 },
      ],
      pickup_point_id: 1,
      payment_method: "cod",
      note: "Pedas",
    })
    .expect(201);
  kode = res.body.data.code;
  await request(app).post(`/api/v1/orders/${kode}/cancel`).set(authHeader(setup.customerToken)).expect(200);
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("pesan lagi", () => {
  test("request = isi pesanan lama (menu, qty, opsi, titik temu, catatan) + quote harga terkini", async () => {
    await db.query("UPDATE menus SET price = 16000 WHERE id = ?", [setup.menu]);
    const res = await lagi().expect(200);
    expect(res.body.data.request).toEqual({
      items: [
        { menu_id: setup.menu, qty: 2, option_ids: [setup.keju] },
        { menu_id: setup.menu2, qty: 1, option_ids: [] },
      ],
      pickup_point_id: 1,
      note: "Pedas",
      promo_code: null,
      promo_codes: [],
      customer_name: null,
      customer_phone: null,
      pickup_at: null,
    });
    // (16000 + 3000) × 2 + 5000
    expect(res.body.data.quote).toMatchObject({ subtotal: 43000, total: 43000, warnings: [] });
    const baru = await request(app)
      .post("/api/v1/orders")
      .set(authHeader(setup.customerToken))
      .set("Idempotency-Key", randomUUID())
      .send({ ...res.body.data.request, payment_method: "cod" })
      .expect(201);
    expect(baru.body.data.code).not.toBe(kode);
  });

  test("pesanan orang lain 404; menu sudah nonaktif → 400 per baris", async () => {
    await lagi(kode, await createCustomer(1)).expect(404);
    await db.query("UPDATE menus SET is_active = FALSE WHERE id = ?", [setup.menu2]);
    expect((await lagi().expect(400)).body.error.fields).toEqual({ "items.1.menu_id": ["Menu tidak tersedia."] });
  });
});
