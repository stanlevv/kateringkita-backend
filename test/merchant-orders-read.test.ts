import request from "supertest";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { hariIniWib } from "../src/merchant/kuota";
import { pesanDulu, siapCheckout, sisipMenu, tampilkan } from "./helpers/toko";

// F07 Task 3: GET /merchant/orders & /merchant/orders/:code (M-04, R-10, R-11; D9, D11–D13)
let s: Awaited<ReturnType<typeof siapCheckout>>;
const k: Record<string, string> = {};

const KUNCI = [
  "cancel_reason", "cancelled_at", "cancelled_by", "code", "completed_at", "confirmed_at", "cooking_at", "created_at", "customer_name",
  "customer_phone", "discount", "hold_until", "items", "note", "payment_method", "payment_status", "pickup_at", "pickup_point", "ready_at",
  "seconds_left", "service_fee", "status", "subtotal", "total", "updated_at",
];
const daftar = (qs = "", token = s.tA) => request(app).get(`/api/v1/merchant/orders${qs}`).set("Authorization", `Bearer ${token}`);
const kodeDari = (r: request.Response) => r.body.data.map((o: { code: string }) => o.code).sort();
const atur = (code: string, o: Record<string, unknown>) => db.query("UPDATE orders SET ? WHERE code = ?", [o, code]);
const kemarin = () => new Date(Date.parse(`${hariIniWib()}T00:00:00Z`) - 86400e3).toISOString().slice(0, 10);

beforeAll(async () => {
  s = await siapCheckout();
  await tampilkan(s.idB);
  await db.query("INSERT INTO merchant_pickup_points (merchant_id, pickup_point_id) VALUES (?, 1)", [s.idB]);
  const menuB = await sisipMenu(s.idB, { name: "Soto" });
  k.holding = await pesanDulu(s.tCust, s.menu, 2);
  k.confirmed = await pesanDulu(s.tCust, s.menu);
  await atur(k.confirmed, { status: "confirmed" });
  k.completed = await pesanDulu(s.tCust, s.menu2);
  await atur(k.completed, { status: "completed" });
  k.b = await pesanDulu(s.tCust, menuB);
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("GET /merchant/orders", () => {
  test("hanya pesanan toko sendiri, bentuk MerchantOrder tanpa hpp/merchant/can_*", async () => {
    const r = await daftar().expect(200);
    expect(kodeDari(r)).toEqual([k.holding, k.confirmed, k.completed].sort());
    expect(r.body.meta).toEqual({ page: 1, limit: 20, total: 3 });
    for (const o of r.body.data) expect(Object.keys(o).sort()).toEqual(KUNCI);
    expect(JSON.stringify(r.body)).not.toMatch(/"hpp"|"merchant"|"can_cancel"/);
    const h = r.body.data.find((o: any) => o.code === k.holding);
    expect(h).toMatchObject({
      customer_name: "Budi", customer_phone: "081234567890", cancel_reason: null, cancelled_by: null, confirmed_at: null,
      status: "holding", items: [{ menu_name: "Nasi Ayam", qty: 2, unit_price: 15000, line_total: 30000, options: [] }],
    });
    expect(h.seconds_left).toBeGreaterThan(0);
    expect(r.body.data.find((o: any) => o.code === k.confirmed)).toMatchObject({ hold_until: null, seconds_left: null });
  });

  test("status daftar koma; status tak dikenal → 400", async () => {
    expect(kodeDari(await daftar("?status=holding,confirmed").expect(200))).toEqual([k.holding, k.confirmed].sort());
    const r = await daftar("?status=holding,dimasak").expect(400);
    expect(r.body.error).toMatchObject({ code: "VALIDATION_ERROR", fields: { status: ["Status tidak dikenal."] } });
  });

  test("date = tanggal WIB created_at", async () => {
    expect(kodeDari(await daftar(`?date=${hariIniWib()}`).expect(200))).toHaveLength(3);
    await atur(k.completed, { created_at: `${kemarin()} 17:30:00` }); // hari ini 00:30 WIB
    expect(kodeDari(await daftar(`?date=${hariIniWib()}`).expect(200))).toContain(k.completed);
    await atur(k.completed, { created_at: `${kemarin()} 16:59:59` }); // kemarin 23:59:59 WIB
    expect(kodeDari(await daftar(`?date=${hariIniWib()}`).expect(200))).not.toContain(k.completed);
    expect(kodeDari(await daftar(`?date=${kemarin()}`).expect(200))).toEqual([k.completed]);
    expect((await daftar("?date=2026-13-01").expect(400)).body.error.fields).toEqual({ date: ["Tanggal tidak valid."] });
  });

  test("q: nama pembeli tanpa beda huruf, sebagian kode", async () => {
    expect(kodeDari(await daftar("?q=budi").expect(200))).toHaveLength(3);
    expect(kodeDari(await daftar(`?q=${k.holding.slice(-4)}`).expect(200))).toEqual([k.holding]);
  });

  test("page/limit + meta.total", async () => {
    const r = await daftar("?page=2&limit=2").expect(200);
    expect(r.body.data).toHaveLength(1);
    expect(r.body.meta).toEqual({ page: 2, limit: 2, total: 3 });
    expect((await daftar("?limit=0").expect(400)).body.error.fields).toEqual({ limit: ["Halaman tidak valid."] });
  });

  test("updated_since: status diabaikan; tidak valid → 400", async () => {
    await db.query("UPDATE orders SET updated_at = UTC_TIMESTAMP() - INTERVAL 1 HOUR");
    const t = new Date(Date.now() - 1800e3).toISOString();
    await atur(k.confirmed, { status: "cooking", updated_at: new Date() });
    const r = await daftar(`?status=holding&updated_since=${encodeURIComponent(t)}`).expect(200);
    expect(r.body.data.map((o: any) => [o.code, o.status])).toEqual([[k.confirmed, "cooking"]]);
    expect((await daftar("?updated_since=kemarin").expect(400)).body.error.fields).toEqual({ updated_since: ["Waktu tidak valid."] });
  });
});

describe("updated_since berurut (review)", () => {
  test("urut updated_at naik: halaman berikutnya dari tanda air tidak melompat", async () => {
    const t0 = Date.now() - 3600e3;
    await db.query("UPDATE orders SET updated_at = ?", [new Date(t0 - 3600e3)]);
    const detik = [3, 1, 2]; // holding paling baru, confirmed paling lama
    for (const [i, c] of [k.holding, k.confirmed, k.completed].entries()) await atur(c, { updated_at: new Date(t0 + detik[i] * 1000) });
    const r1 = await daftar(`?updated_since=${new Date(t0).toISOString()}&limit=2`).expect(200);
    expect(r1.body.data.map((o: any) => o.code)).toEqual([k.confirmed, k.completed]);
    const r2 = await daftar(`?updated_since=${r1.body.data.at(-1).updated_at}&limit=2`).expect(200);
    expect(r2.body.data.map((o: any) => o.code)).toEqual([k.completed, k.holding]);
  });
});

describe("GET /merchant/orders/:code", () => {
  test("200 bentuk sama; toko lain → 404; pembeli → 403", async () => {
    const r = await request(app).get(`/api/v1/merchant/orders/${k.holding}`).set("Authorization", `Bearer ${s.tA}`).expect(200);
    expect(Object.keys(r.body.data).sort()).toEqual(KUNCI);
    expect(r.body.data.code).toBe(k.holding);
    const b = await request(app).get(`/api/v1/merchant/orders/${k.b}`).set("Authorization", `Bearer ${s.tA}`).expect(404);
    expect(b.body.error.message).toBe("Pesanan tidak ditemukan.");
    await request(app).get(`/api/v1/merchant/orders/${k.holding}`).set("Authorization", `Bearer ${s.tCust}`).expect(403);
    await daftar("", s.tCust).expect(403);
  });
});

// TiDB memakai utf8mb4_bin secara bawaan: pencarian harus tetap tak peka huruf (test terakhir: mengubah skema file ini)
test("q tak peka huruf walau kolom berkolasi biner", async () => {
  await db.query("ALTER TABLE orders MODIFY customer_name VARCHAR(150) NOT NULL COLLATE utf8mb4_bin, MODIFY code VARCHAR(20) NOT NULL COLLATE utf8mb4_bin");
  expect(kodeDari(await daftar("?q=BUDI").expect(200))).toHaveLength(3);
  expect(kodeDari(await daftar(`?q=${k.holding.toLowerCase()}`).expect(200))).toEqual([k.holding]);
});
