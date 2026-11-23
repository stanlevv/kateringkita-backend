import request from "supertest";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { getWibDate } from "../src/services/merchant-quota.service";
import { placeOrder, prepareCheckout, insertMenu, makeVisible } from "./helpers/merchant";

// GET /merchant/orders & /merchant/orders/:code
let setup: Awaited<ReturnType<typeof prepareCheckout>>;
const codes: Record<string, string> = {};

const KUNCI = [
  "cancel_reason",
  "cancelled_at",
  "cancelled_by",
  "code",
  "completed_at",
  "confirmed_at",
  "cooking_at",
  "created_at",
  "customer_name",
  "customer_phone",
  "discount",
  "hold_until",
  "items",
  "note",
  "payment_method",
  "payment_status",
  "pickup_at",
  "pickup_point",
  "ready_at",
  "seconds_left",
  "service_fee",
  "status",
  "subtotal",
  "table",
  "total",
  "updated_at",
];
const daftar = (query = "", token = setup.tokenA) =>
  request(app).get(`/api/v1/merchant/orders${query}`).set("Authorization", `Bearer ${token}`);
const kodeDari = (res: request.Response) => res.body.data.map((order: { code: string }) => order.code).sort();
const atur = (code: string, fields: Record<string, unknown>) =>
  db.query("UPDATE orders SET ? WHERE code = ?", [fields, code]);
const kemarin = () => new Date(Date.parse(`${getWibDate()}T00:00:00Z`) - 86400e3).toISOString().slice(0, 10);

beforeAll(async () => {
  setup = await prepareCheckout();
  await makeVisible(setup.idB);
  await db.query("INSERT INTO merchant_pickup_points (merchant_id, pickup_point_id) VALUES (?, 1)", [setup.idB]);
  const menuB = await insertMenu(setup.idB, { name: "Soto" });
  codes.holding = await placeOrder(setup.customerToken, setup.menu, 2);
  codes.confirmed = await placeOrder(setup.customerToken, setup.menu);
  await atur(codes.confirmed, { status: "confirmed" });
  codes.completed = await placeOrder(setup.customerToken, setup.menu2);
  await atur(codes.completed, { status: "completed" });
  codes.b = await placeOrder(setup.customerToken, menuB);
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("GET /merchant/orders", () => {
  test("hanya pesanan toko sendiri, bentuk MerchantOrder tanpa hpp/merchant/can_*", async () => {
    const res = await daftar().expect(200);
    expect(kodeDari(res)).toEqual([codes.holding, codes.confirmed, codes.completed].sort());
    expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 3 });
    for (const listedOrder of res.body.data) expect(Object.keys(listedOrder).sort()).toEqual(KUNCI);
    expect(JSON.stringify(res.body)).not.toMatch(/"hpp"|"merchant"|"can_cancel"/);
    const holdingOrder = res.body.data.find((order: any) => order.code === codes.holding);
    expect(holdingOrder).toMatchObject({
      customer_name: "Budi",
      customer_phone: "081234567890",
      cancel_reason: null,
      cancelled_by: null,
      confirmed_at: null,
      status: "holding",
      items: [{ menu_name: "Nasi Ayam", qty: 2, unit_price: 15000, line_total: 30000, options: [] }],
    });
    expect(holdingOrder.seconds_left).toBeGreaterThan(0);
    expect(res.body.data.find((order: any) => order.code === codes.confirmed)).toMatchObject({
      hold_until: null,
      seconds_left: null,
    });
  });

  test("status daftar koma; status tak dikenal → 400", async () => {
    expect(kodeDari(await daftar("?status=holding,confirmed").expect(200))).toEqual(
      [codes.holding, codes.confirmed].sort(),
    );
    const res = await daftar("?status=holding,dimasak").expect(400);
    expect(res.body.error).toMatchObject({ code: "VALIDATION_ERROR", fields: { status: ["Status tidak dikenal."] } });
  });

  test("date = tanggal WIB created_at", async () => {
    expect(kodeDari(await daftar(`?date=${getWibDate()}`).expect(200))).toHaveLength(3);
    await atur(codes.completed, { created_at: `${kemarin()} 17:30:00` }); // hari ini 00:30 WIB
    expect(kodeDari(await daftar(`?date=${getWibDate()}`).expect(200))).toContain(codes.completed);
    await atur(codes.completed, { created_at: `${kemarin()} 16:59:59` }); // kemarin 23:59:59 WIB
    expect(kodeDari(await daftar(`?date=${getWibDate()}`).expect(200))).not.toContain(codes.completed);
    expect(kodeDari(await daftar(`?date=${kemarin()}`).expect(200))).toEqual([codes.completed]);
    expect((await daftar("?date=2026-13-01").expect(400)).body.error.fields).toEqual({
      date: ["Tanggal tidak valid."],
    });
  });

  test("q: nama pembeli tanpa beda huruf, sebagian kode", async () => {
    expect(kodeDari(await daftar("?q=budi").expect(200))).toHaveLength(3);
    expect(kodeDari(await daftar(`?q=${codes.holding.slice(-4)}`).expect(200))).toEqual([codes.holding]);
  });

  test("page/limit + meta.total", async () => {
    const res = await daftar("?page=2&limit=2").expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.meta).toEqual({ page: 2, limit: 2, total: 3 });
    expect((await daftar("?limit=0").expect(400)).body.error.fields).toEqual({ limit: ["Halaman tidak valid."] });
  });

  test("updated_since: status diabaikan; tidak valid → 400", async () => {
    await db.query("UPDATE orders SET updated_at = UTC_TIMESTAMP() - INTERVAL 1 HOUR");
    const since = new Date(Date.now() - 1800e3).toISOString();
    await atur(codes.confirmed, { status: "cooking", updated_at: new Date() });
    const res = await daftar(`?status=holding&updated_since=${encodeURIComponent(since)}`).expect(200);
    expect(res.body.data.map((order: any) => [order.code, order.status])).toEqual([[codes.confirmed, "cooking"]]);
    expect((await daftar("?updated_since=kemarin").expect(400)).body.error.fields).toEqual({
      updated_since: ["Waktu tidak valid."],
    });
  });
});

describe("updated_since berurut (review)", () => {
  test("urut updated_at naik: halaman berikutnya dari tanda air tidak melompat", async () => {
    const startMs = Date.now() - 3600e3;
    await db.query("UPDATE orders SET updated_at = ?", [new Date(startMs - 3600e3)]);
    const detik = [3, 1, 2]; // holding paling baru, confirmed paling lama
    for (const [i, code] of [codes.holding, codes.confirmed, codes.completed].entries())
      await atur(code, { updated_at: new Date(startMs + detik[i] * 1000) });
    const res1 = await daftar(`?updated_since=${new Date(startMs).toISOString()}&limit=2`).expect(200);
    expect(res1.body.data.map((order: any) => order.code)).toEqual([codes.confirmed, codes.completed]);
    const res2 = await daftar(`?updated_since=${res1.body.data.at(-1).updated_at}&limit=2`).expect(200);
    expect(res2.body.data.map((order: any) => order.code)).toEqual([codes.completed, codes.holding]);
  });
});

describe("GET /merchant/orders/:code", () => {
  test("200 bentuk sama; toko lain → 404; pembeli → 403", async () => {
    const res = await request(app)
      .get(`/api/v1/merchant/orders/${codes.holding}`)
      .set("Authorization", `Bearer ${setup.tokenA}`)
      .expect(200);
    expect(Object.keys(res.body.data).sort()).toEqual(KUNCI);
    expect(res.body.data.code).toBe(codes.holding);
    const otherRes = await request(app)
      .get(`/api/v1/merchant/orders/${codes.b}`)
      .set("Authorization", `Bearer ${setup.tokenA}`)
      .expect(404);
    expect(otherRes.body.error.message).toBe("Pesanan tidak ditemukan.");
    await request(app)
      .get(`/api/v1/merchant/orders/${codes.holding}`)
      .set("Authorization", `Bearer ${setup.customerToken}`)
      .expect(403);
    await daftar("", setup.customerToken).expect(403);
  });
});

// TiDB memakai utf8mb4_bin secara bawaan: pencarian harus tetap tak peka huruf (test terakhir: mengubah skema file ini)
test("q tak peka huruf walau kolom berkolasi biner", async () => {
  await db.query(
    "ALTER TABLE orders MODIFY customer_name VARCHAR(150) NOT NULL COLLATE utf8mb4_bin, MODIFY code VARCHAR(20) NOT NULL COLLATE utf8mb4_bin",
  );
  expect(kodeDari(await daftar("?q=BUDI").expect(200))).toHaveLength(3);
  expect(kodeDari(await daftar(`?q=${codes.holding.toLowerCase()}`).expect(200))).toEqual([codes.holding]);
});
