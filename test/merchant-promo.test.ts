import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { createCustomer, prepareCheckout } from "./helpers/merchant";

// F12: CRUD /merchant/promos + kode promo di quote & checkout
let setup: Awaited<ReturnType<typeof prepareCheckout>>;
const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });
const promo = (overrides: object = {}) => ({
  code: " hemat10 ",
  description: "Diskon toko",
  type: "percent",
  value: 10,
  max_discount: 2000,
  min_subtotal: 10000,
  quota: 2,
  per_user_limit: 1,
  starts_at: "2020-01-01T00:00:00.000Z",
  ends_at: "2099-01-01T00:00:00.000Z",
  ...overrides,
});
const buat = (overrides: object = {}, token = setup.tokenA) =>
  request(app).post("/api/v1/merchant/promos").set(authHeader(token)).send(promo(overrides));
const isi = (code: string | null, qty = 2) => ({
  items: [{ menu_id: setup.menu, qty }],
  pickup_point_id: 1,
  payment_method: "cod",
  promo_code: code,
});
const quote = (code: string | null, qty = 2, token = setup.customerToken) =>
  request(app).post("/api/v1/orders/quote").set(authHeader(token)).send(isi(code, qty));
const pesan = (code: string | null, token = setup.customerToken) =>
  request(app).post("/api/v1/orders").set(authHeader(token)).set("Idempotency-Key", randomUUID()).send(isi(code));
const promoRow = async (code: string) =>
  ((await db.query<any[]>("SELECT * FROM promos WHERE code = ?", [code]))[0] as any[])[0];

beforeAll(async () => {
  setup = await prepareCheckout();
});
afterEach(async () => {
  await db.query("UPDATE orders SET status = 'expired' WHERE status = 'holding'");
  await db.query("UPDATE menus SET held_today = 0");
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("CRUD promo toko", () => {
  test("buat (kode dirapikan, aktif bawaan), daftar hanya milik toko, kode unik global", async () => {
    const res = await buat().expect(201);
    expect(res.body.data).toMatchObject({ code: "HEMAT10", merchant_id: setup.idA, is_active: true, used_count: 0 });
    expect((await buat({}, setup.tokenB).expect(409)).body.error.fields).toEqual({ code: ["Kode sudah dipakai."] });
    await buat({ code: "TOKOB", is_active: false }, setup.tokenB).expect(201);
    const daftar = await request(app).get("/api/v1/merchant/promos").set(authHeader(setup.tokenA)).expect(200);
    expect(daftar.body.data.map((item: { code: string }) => item.code)).toEqual(["HEMAT10"]);
    expect((await buat({ code: "X", value: 0 }).expect(400)).body.error.fields).toMatchObject({
      code: expect.any(Array),
      value: ["Nilai minimal 1."],
    });
  });

  test("PATCH sebagian + is_active + ganti kode; toko lain 404", async () => {
    const { id } = await promoRow("HEMAT10");
    const res = await request(app)
      .patch(`/api/v1/merchant/promos/${id}`)
      .set(authHeader(setup.tokenA))
      .send({ value: 20, is_active: false })
      .expect(200);
    expect(res.body.data).toMatchObject({ value: 20, is_active: false, max_discount: 2000 });
    await request(app)
      .patch(`/api/v1/merchant/promos/${id}`)
      .set(authHeader(setup.tokenA))
      .send({ is_active: "ya" })
      .expect(400);
    await request(app)
      .patch(`/api/v1/merchant/promos/${id}`)
      .set(authHeader(setup.tokenB))
      .send({ value: 5 })
      .expect(404);
    await request(app)
      .patch(`/api/v1/merchant/promos/${id}`)
      .set(authHeader(setup.tokenA))
      .send({ code: "tokob" })
      .expect(409);
    await request(app)
      .patch(`/api/v1/merchant/promos/${id}`)
      .set(authHeader(setup.tokenA))
      .send({ value: 10, is_active: true })
      .expect(200);
  });
});

describe("kode promo di checkout", () => {
  test("quote: persen dibatasi max_discount; promo toko lain / nonaktif / min belanja ditolak", async () => {
    // 2 × 15000 = 30000; 10% = 3000 → dibatasi 2000
    expect((await quote("hemat10").expect(200)).body.data).toMatchObject({
      subtotal: 30000,
      discount: 2000,
      total: 28000,
    });
    expect((await quote("TOKOB").expect(422)).body.error).toMatchObject({
      code: "PROMO_INVALID",
      fields: { promo_code: ["Kode promo tidak ditemukan."] },
    });
    expect((await quote("HEMAT10", 1)).status).toBe(200); // 15000 ≥ 10000
    // Es Teh 5000 < min belanja 10000
    const kecil = await request(app)
      .post("/api/v1/orders/quote")
      .set(authHeader(setup.customerToken))
      .send({ ...isi("HEMAT10"), items: [{ menu_id: setup.menu2, qty: 1 }] })
      .expect(422);
    expect(kecil.body.error.message).toBe("Minimal belanja Rp 10.000 untuk promo ini.");
  });

  test("pesanan: discount, promo_id, redemption, kuota & batas per pembeli; batal mengembalikan kuota", async () => {
    const res = await pesan("HEMAT10").expect(201);
    expect(res.body.data).toMatchObject({ discount: 2000, total: 28000 });
    const promoRecord = await promoRow("HEMAT10");
    expect(promoRecord.used_count).toBe(1);
    const [[order]] = await db.query<any[]>(
      "SELECT id, promo_id, merchant_promo_id, merchant_discount FROM orders WHERE code = ?",
      [res.body.data.code],
    );
    expect(order).toMatchObject({
      promo_id: null,
      merchant_promo_id: promoRecord.id,
      merchant_discount: res.body.data.discount,
    }); // voucher toko (migrasi 014)
    expect((await pesan("HEMAT10").expect(422)).body.error.message).toBe("Promo ini sudah mencapai batas pemakaianmu.");

    await request(app)
      .post(`/api/v1/orders/${res.body.data.code}/cancel`)
      .set(authHeader(setup.customerToken))
      .expect(200);
    expect((await promoRow("HEMAT10")).used_count).toBe(0);
    const [[countRow]] = await db.query<any[]>("SELECT COUNT(*) AS n FROM promo_redemptions WHERE order_id = ?", [
      order.id,
    ]);
    expect(Number(countRow.n)).toBe(0);

    // kuota 2: dua pembeli lain habiskan, pembeli ketiga ditolak
    const [firstToken, secondToken] = [await createCustomer(1), await createCustomer(2)];
    await pesan("HEMAT10", firstToken).expect(201);
    await pesan("HEMAT10", secondToken).expect(201);
    expect((await pesan("HEMAT10").expect(422)).body.error.message).toBe("Kuota promo sudah habis.");
  });

  test("free_service_fee & fixed; promo platform berlaku di semua toko", async () => {
    await db.query("UPDATE app_settings SET setting_value = '2000' WHERE setting_key = 'service_fee'");
    // C2: penjual tidak bisa membuat jenis ini lagi; promo lama jenis ini tetap berlaku di checkout
    expect(
      (await buat({ code: "GRATISLAYANAN", type: "free_service_fee", value: 0, quota: null }).expect(400)).body.error
        .fields.type,
    ).toEqual(["Promo toko hanya potongan persen atau nominal."]);
    await db.query(
      `INSERT INTO promos (merchant_id, code, type, value, min_subtotal, per_user_limit, starts_at, ends_at)
       VALUES (?, 'GRATISLAYANAN', 'free_service_fee', 0, 0, 1, '2020-01-01', '2099-01-01')`,
      [setup.idA],
    );
    expect((await quote("GRATISLAYANAN").expect(200)).body.data).toMatchObject({
      service_fee: 2000,
      discount: 2000,
      total: 30000,
    });
    await db.query(
      `INSERT INTO promos (merchant_id, code, type, value, min_subtotal, per_user_limit, starts_at, ends_at)
       VALUES (NULL, 'PLATFORM5K', 'fixed', 5000, 0, 1, '2020-01-01', '2099-01-01')`,
    );
    expect((await quote("platform5k").expect(200)).body.data).toMatchObject({ discount: 5000, total: 27000 });
    await db.query("UPDATE app_settings SET setting_value = '0' WHERE setting_key = 'service_fee'");
  });

  test("hapus hanya bila belum dipakai", async () => {
    const { id } = await promoRow("HEMAT10");
    expect(
      (await request(app).delete(`/api/v1/merchant/promos/${id}`).set(authHeader(setup.tokenA)).expect(409)).body.error
        .message,
    ).toBe("Promo sudah dipakai. Nonaktifkan saja.");
    const freeFeePromo = await promoRow("GRATISLAYANAN");
    expect(
      (
        await request(app)
          .delete(`/api/v1/merchant/promos/${freeFeePromo.id}`)
          .set(authHeader(setup.tokenA))
          .expect(200)
      ).body,
    ).toEqual({
      data: { id: freeFeePromo.id },
    });
    await request(app).delete(`/api/v1/merchant/promos/${freeFeePromo.id}`).set(authHeader(setup.tokenA)).expect(404);
  });
});
