import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { pembeliBaru, siapCheckout } from "./helpers/toko";

// F12: CRUD /merchant/promos + kode promo di quote & checkout
let s: Awaited<ReturnType<typeof siapCheckout>>;
const H = (t: string) => ({ Authorization: `Bearer ${t}` });
const promo = (b: object = {}) => ({
  code: " hemat10 ", description: "Diskon toko", type: "percent", value: 10, max_discount: 2000, min_subtotal: 10000, quota: 2,
  per_user_limit: 1, starts_at: "2020-01-01T00:00:00.000Z", ends_at: "2099-01-01T00:00:00.000Z", ...b,
});
const buat = (b: object = {}, t = s.tA) => request(app).post("/api/v1/merchant/promos").set(H(t)).send(promo(b));
const isi = (code: string | null, qty = 2) => ({ items: [{ menu_id: s.menu, qty }], pickup_point_id: 1, payment_method: "cod", promo_code: code });
const quote = (code: string | null, qty = 2, t = s.tCust) => request(app).post("/api/v1/orders/quote").set(H(t)).send(isi(code, qty));
const pesan = (code: string | null, t = s.tCust) =>
  request(app).post("/api/v1/orders").set(H(t)).set("Idempotency-Key", randomUUID()).send(isi(code));
const promoRow = async (code: string) => ((await db.query<any[]>("SELECT * FROM promos WHERE code = ?", [code]))[0] as any[])[0];

beforeAll(async () => {
  s = await siapCheckout();
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
    const r = await buat().expect(201);
    expect(r.body.data).toMatchObject({ code: "HEMAT10", merchant_id: s.idA, is_active: true, used_count: 0 });
    expect((await buat({}, s.tB).expect(409)).body.error.fields).toEqual({ code: ["Kode sudah dipakai."] });
    await buat({ code: "TOKOB", is_active: false }, s.tB).expect(201);
    const daftar = await request(app).get("/api/v1/merchant/promos").set(H(s.tA)).expect(200);
    expect(daftar.body.data.map((p: { code: string }) => p.code)).toEqual(["HEMAT10"]);
    expect((await buat({ code: "X", value: 0 }).expect(400)).body.error.fields).toMatchObject({ code: expect.any(Array), value: ["Nilai minimal 1."] });
  });

  test("PATCH sebagian + is_active + ganti kode; toko lain 404", async () => {
    const { id } = await promoRow("HEMAT10");
    const r = await request(app).patch(`/api/v1/merchant/promos/${id}`).set(H(s.tA)).send({ value: 20, is_active: false }).expect(200);
    expect(r.body.data).toMatchObject({ value: 20, is_active: false, max_discount: 2000 });
    await request(app).patch(`/api/v1/merchant/promos/${id}`).set(H(s.tA)).send({ is_active: "ya" }).expect(400);
    await request(app).patch(`/api/v1/merchant/promos/${id}`).set(H(s.tB)).send({ value: 5 }).expect(404);
    await request(app).patch(`/api/v1/merchant/promos/${id}`).set(H(s.tA)).send({ code: "tokob" }).expect(409);
    await request(app).patch(`/api/v1/merchant/promos/${id}`).set(H(s.tA)).send({ value: 10, is_active: true }).expect(200);
  });
});

describe("kode promo di checkout", () => {
  test("quote: persen dibatasi max_discount; promo toko lain / nonaktif / min belanja ditolak", async () => {
    // 2 × 15000 = 30000; 10% = 3000 → dibatasi 2000
    expect((await quote("hemat10").expect(200)).body.data).toMatchObject({ subtotal: 30000, discount: 2000, total: 28000 });
    expect((await quote("TOKOB").expect(422)).body.error).toMatchObject({ code: "PROMO_INVALID", fields: { promo_code: ["Kode promo tidak ditemukan."] } });
    expect((await quote("HEMAT10", 1)).status).toBe(200); // 15000 ≥ 10000
    // Es Teh 5000 < min belanja 10000
    const kecil = await request(app).post("/api/v1/orders/quote").set(H(s.tCust))
      .send({ ...isi("HEMAT10"), items: [{ menu_id: s.menu2, qty: 1 }] }).expect(422);
    expect(kecil.body.error.message).toBe("Minimal belanja Rp 10.000 untuk promo ini.");
  });

  test("pesanan: discount, promo_id, redemption, kuota & batas per pembeli; batal mengembalikan kuota", async () => {
    const r = await pesan("HEMAT10").expect(201);
    expect(r.body.data).toMatchObject({ discount: 2000, total: 28000 });
    const p = await promoRow("HEMAT10");
    expect(p.used_count).toBe(1);
    const [[o]] = await db.query<any[]>("SELECT id, promo_id FROM orders WHERE code = ?", [r.body.data.code]);
    expect(o.promo_id).toBe(p.id);
    expect((await pesan("HEMAT10").expect(422)).body.error.message).toBe("Promo ini sudah mencapai batas pemakaianmu.");

    await request(app).post(`/api/v1/orders/${r.body.data.code}/cancel`).set(H(s.tCust)).expect(200);
    expect((await promoRow("HEMAT10")).used_count).toBe(0);
    const [[n]] = await db.query<any[]>("SELECT COUNT(*) AS n FROM promo_redemptions WHERE order_id = ?", [o.id]);
    expect(Number(n.n)).toBe(0);

    // kuota 2: dua pembeli lain habiskan, pembeli ketiga ditolak
    const [p1, p2] = [await pembeliBaru(1), await pembeliBaru(2)];
    await pesan("HEMAT10", p1).expect(201);
    await pesan("HEMAT10", p2).expect(201);
    expect((await pesan("HEMAT10").expect(422)).body.error.message).toBe("Kuota promo sudah habis.");
  });

  test("free_service_fee & fixed; promo platform berlaku di semua toko", async () => {
    await db.query("UPDATE app_settings SET setting_value = '2000' WHERE setting_key = 'service_fee'");
    await buat({ code: "GRATISLAYANAN", type: "free_service_fee", value: 0, quota: null }).expect(201);
    expect((await quote("GRATISLAYANAN").expect(200)).body.data).toMatchObject({ service_fee: 2000, discount: 2000, total: 30000 });
    await db.query(
      `INSERT INTO promos (merchant_id, code, type, value, min_subtotal, per_user_limit, starts_at, ends_at)
       VALUES (NULL, 'PLATFORM5K', 'fixed', 5000, 0, 1, '2020-01-01', '2099-01-01')`,
    );
    expect((await quote("platform5k").expect(200)).body.data).toMatchObject({ discount: 5000, total: 27000 });
    await db.query("UPDATE app_settings SET setting_value = '0' WHERE setting_key = 'service_fee'");
  });

  test("hapus hanya bila belum dipakai", async () => {
    const { id } = await promoRow("HEMAT10");
    expect((await request(app).delete(`/api/v1/merchant/promos/${id}`).set(H(s.tA)).expect(409)).body.error.message)
      .toBe("Promo sudah dipakai. Nonaktifkan saja.");
    const g = await promoRow("GRATISLAYANAN");
    expect((await request(app).delete(`/api/v1/merchant/promos/${g.id}`).set(H(s.tA)).expect(200)).body).toEqual({ data: { id: g.id } });
    await request(app).delete(`/api/v1/merchant/promos/${g.id}`).set(H(s.tA)).expect(404);
  });
});
