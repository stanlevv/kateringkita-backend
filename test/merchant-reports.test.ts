import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { getWibDate } from "../src/services/merchant-quota.service";
import { toUtcRange } from "../src/services/merchant-report.service";
import { placeOrder, prepareCheckout, insertMenu, makeVisible } from "./helpers/merchant";

// F09: /merchant/reports/* (M-09, R-10; D1–D9)
let setup: Awaited<ReturnType<typeof prepareCheckout>>;
const codes: Record<string, string> = {};

const atur = (code: string, values: Record<string, unknown>) =>
  db.query("UPDATE orders SET ? WHERE code = ?", [values, code]);
const wib = (date: string, hms: string) => new Date(Date.parse(`${date}T${hms}+07:00`));
const geser = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400e3).toISOString().slice(0, 10);
const HARI = getWibDate();
const HOURLY_TEST_DAY = "2026-03-20"; // hari uji laporan per jam; completed_at disimpan UTC (WIB − 7 jam)
// Hari uji tetap di masa lalu: batas WIB sama dengan "kemarin 17:30 UTC = hari ini 00:30 WIB" tanpa mencemari data hari ini
const BOUNDARY_TEST_DAY = "2026-03-10";
const get = (jalur: string, query: string, token = setup.tokenA) =>
  request(app).get(`/api/v1/merchant/reports/${jalur}?${query}`).set("Authorization", `Bearer ${token}`);
const ringkasan = (startDate: string, endDate = startDate) => get("summary", `from=${startDate}&to=${endDate}`);
const salahTanggal = async (query: string, pesan: string[]) => {
  const res = await get("hourly", query).expect(400);
  expect(res.body.error).toMatchObject({
    code: "VALIDATION_ERROR",
    message: "Data tidak valid.",
    fields: { date: pesan },
  });
  expect(Object.keys(res.body.error.fields)).toEqual(["date"]);
};
const KUNCI_TRX = [
  "code",
  "completed_at",
  "created_at",
  "customer_name",
  "hpp_total",
  "menu_name",
  "payment_method",
  "qty",
  "status",
  "total",
];

// pesanan dua menu: 2× Nasi Ayam (15.000/HPP 9.000) + 1× Es Teh (5.000/HPP 2.000)
async function pesanDua(token: string): Promise<string> {
  const res = await request(app)
    .post("/api/v1/orders")
    .set("Authorization", `Bearer ${token}`)
    .set("Idempotency-Key", randomUUID())
    .send({
      items: [
        { menu_id: setup.menu, qty: 2 },
        { menu_id: setup.menu2, qty: 1 },
      ],
      pickup_point_id: 1,
      payment_method: "cod",
    })
    .expect(201);
  return res.body.data.code;
}

beforeAll(async () => {
  setup = await prepareCheckout();
  await makeVisible(setup.idB);
  await db.query("INSERT INTO merchant_pickup_points (merchant_id, pickup_point_id) VALUES (?, 1)", [setup.idB]);
  const menuB = await insertMenu(setup.idB, { name: "Soto" });
  const pagi = wib(HARI, "09:00:00");
  const siang = wib(HARI, "12:00:00");
  codes.multi = await pesanDua(setup.customerToken);
  await atur(codes.multi, { status: "completed", completed_at: pagi });
  codes.satu = await placeOrder(setup.customerToken, setup.menu2, 3);
  await atur(codes.satu, { status: "completed", completed_at: siang });
  // tiga status lain punya item dan completed_at, tetap tidak boleh dihitung (D1)
  for (const status of ["cancelled", "expired", "ready"]) {
    codes[status] = await placeOrder(setup.customerToken, setup.menu);
    await atur(codes[status], { status, completed_at: siang });
  }
  codes.b = await placeOrder(setup.customerToken, menuB, 4);
  await atur(codes.b, { status: "completed", completed_at: siang });

  // fixture per jam di hari uji tersendiri (WIB = UTC + 7)
  const first = await pesanDua(setup.customerToken); // 2× Nasi Ayam 30.000 + 1× Es Teh 5.000, 08.10 WIB
  await atur(first, { status: "completed", completed_at: new Date(`${HOURLY_TEST_DAY}T01:10:00Z`) });
  const second = await placeOrder(setup.customerToken, setup.menu2, 3); // 15.000, 08.50 WIB (jam yang sama)
  await atur(second, { status: "completed", completed_at: new Date(`${HOURLY_TEST_DAY}T01:50:00Z`) });
  const third = await placeOrder(setup.customerToken, setup.menu2, 1); // 5.000, 12.05 WIB
  await atur(third, { status: "completed", completed_at: new Date(`${HOURLY_TEST_DAY}T05:05:00Z`) });
  const tengahMalam = await placeOrder(setup.customerToken, setup.menu2); // 5.000, 00.20 WIB
  await atur(tengahMalam, { status: "completed", completed_at: new Date(`${geser(HOURLY_TEST_DAY, -1)}T17:20:00Z`) });
  const akhirHari = await placeOrder(setup.customerToken, setup.menu2); // 5.000, 23.59 WIB
  await atur(akhirHari, { status: "completed", completed_at: new Date(`${HOURLY_TEST_DAY}T16:59:00Z`) });
  const batal = await placeOrder(setup.customerToken, setup.menu2); // status lain, jam 20.00 WIB, tidak boleh muncul
  await atur(batal, { status: "cancelled", completed_at: new Date(`${HOURLY_TEST_DAY}T13:00:00Z`) });
  const tokoB = await placeOrder(setup.customerToken, menuB, 4); // toko lain, jam 10.00 WIB, tidak boleh muncul
  await atur(tokoB, { status: "completed", completed_at: new Date(`${HOURLY_TEST_DAY}T03:00:00Z`) });
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("GET /merchant/reports/summary", () => {
  test("hari ini: revenue/hpp dari order_items pesanan selesai toko sendiri; status lain & toko B tidak ikut", async () => {
    const [[row]] = await db.query<any[]>(
      `SELECT SUM(oi.line_total) AS r, SUM(oi.hpp * oi.qty) AS h FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE o.merchant_id = ? AND o.status = 'completed' AND o.completed_at >= ? AND o.completed_at < ?`,
      [setup.idA, ...toUtcRange({ from: HARI, to: HARI })],
    );
    const res = await ringkasan(HARI).expect(200);
    expect(res.body.data).toEqual({
      target: 0,
      revenue: 50000,
      hpp_total: 26000,
      profit: 24000,
      achievement_pct: 0,
      orders: 2,
    });
    expect(res.body.data.revenue).toBe(Number(row.r));
    expect(res.body.data.hpp_total).toBe(Number(row.h));
  });

  test("rentang tanpa pesanan selesai → semua 0", async () => {
    const res = await ringkasan("2026-01-01").expect(200);
    expect(res.body.data).toEqual({ target: 0, revenue: 0, hpp_total: 0, profit: 0, achievement_pct: 0, orders: 0 });
  });

  test("target = target harian × jumlah hari; achievement_pct dibulatkan, boleh > 100; target 0 → 0", async () => {
    await db.query("UPDATE merchants SET daily_revenue_target = 100000 WHERE id = ?", [setup.idA]);
    const res = await ringkasan(geser(HARI, -2), HARI).expect(200);
    expect(res.body.data).toMatchObject({
      target: 300000,
      revenue: 50000,
      achievement_pct: Math.round((50000 / 300000) * 100),
    });
    await db.query("UPDATE merchants SET daily_revenue_target = 20000 WHERE id = ?", [setup.idA]);
    expect((await ringkasan(HARI).expect(200)).body.data).toMatchObject({ target: 20000, achievement_pct: 250 });
    await db.query("UPDATE merchants SET daily_revenue_target = 0 WHERE id = ?", [setup.idA]);
    expect((await ringkasan(HARI).expect(200)).body.data).toMatchObject({ target: 0, achievement_pct: 0 });
  });

  test("tanggal = completed_at WIB: 00:30 WIB masuk hari itu, 23:59:59 WIB hari sebelumnya; pre-order dibuat sebelumnya masuk hari selesai", async () => {
    const hari = geser(BOUNDARY_TEST_DAY, -1);
    codes.x = await placeOrder(setup.customerToken, setup.menu2); // 00:30 WIB tanggal D
    await atur(codes.x, { status: "completed", completed_at: new Date(`${hari}T17:30:00Z`) });
    codes.y = await placeOrder(setup.customerToken, setup.menu2); // 23:59:59 WIB tanggal D-1
    await atur(codes.y, { status: "completed", completed_at: new Date(`${hari}T16:59:59Z`) });
    codes.z = await placeOrder(setup.customerToken, setup.menu2); // dibuat D-2, selesai D
    await atur(codes.z, {
      status: "completed",
      created_at: wib(geser(BOUNDARY_TEST_DAY, -2), "10:00:00"),
      completed_at: wib(BOUNDARY_TEST_DAY, "09:00:00"),
    });
    expect((await ringkasan(BOUNDARY_TEST_DAY).expect(200)).body.data).toMatchObject({ revenue: 10000, orders: 2 });
    expect((await ringkasan(hari).expect(200)).body.data).toMatchObject({ revenue: 5000, orders: 1 });
    expect((await ringkasan(geser(BOUNDARY_TEST_DAY, -2)).expect(200)).body.data).toMatchObject({
      revenue: 0,
      orders: 0,
    });
  });

  test("salinan order_items: harga/HPP menu diubah dan menu dihapus setelah selesai tidak mengubah angka", async () => {
    await db.query("UPDATE menus SET price = 90000, hpp = 80000, deleted_at = NOW() WHERE merchant_id = ?", [
      setup.idA,
    ]);
    const res = await ringkasan(HARI).expect(200);
    expect(res.body.data).toMatchObject({ revenue: 50000, hpp_total: 26000, profit: 24000 });
  });
});

describe("GET /merchant/reports/transactions", () => {
  test("satu baris per item, kunci persis, urut completed_at terbaru; toko B & status lain tidak ikut", async () => {
    const res = await get("transactions", `from=${HARI}&to=${HARI}`).expect(200);
    for (const row of res.body.data) expect(Object.keys(row).sort()).toEqual(KUNCI_TRX);
    expect(res.body.data.map((row: any) => [row.code, row.menu_name])).toEqual([
      [codes.satu, "Es Teh"],
      [codes.multi, "Nasi Ayam"],
      [codes.multi, "Es Teh"],
    ]);
    expect(res.body.data[0]).toMatchObject({
      customer_name: "Budi",
      payment_method: "cod",
      qty: 3,
      total: 15000,
      hpp_total: 6000,
      status: "completed",
      completed_at: wib(HARI, "12:00:00").toISOString(),
    });
    expect(res.body.data[1]).toMatchObject({
      qty: 2,
      total: 30000,
      hpp_total: 18000,
      completed_at: wib(HARI, "09:00:00").toISOString(),
    });
    expect(typeof res.body.data[1].created_at).toBe("string");
  });

  test("rentang kosong → []", async () => {
    expect((await get("transactions", "from=2026-01-01&to=2026-01-01").expect(200)).body.data).toEqual([]);
  });
});

describe("validasi query (D9) & penjaga", () => {
  const salah = async (query: string, fields: Record<string, string[]>, jalur = "summary") => {
    const res = await get(jalur, query).expect(400);
    expect(res.body.error).toMatchObject({ code: "VALIDATION_ERROR", message: "Data tidak valid.", fields });
    expect(Object.keys(res.body.error.fields).sort()).toEqual(Object.keys(fields).sort());
  };

  test("tanggal tidak sah / hilang", async () => {
    await salah(`from=2026-13-01&to=${HARI}`, { from: ["Tanggal tidak valid."] });
    await salah(`to=${HARI}`, { from: ["Tanggal tidak valid."] });
    await salah(`from=${HARI}`, { to: ["Tanggal tidak valid."] }, "transactions");
  });

  test("to < from", async () => {
    await salah(`from=${HARI}&to=${geser(HARI, -1)}`, { to: ["Tanggal akhir harus setelah tanggal awal."] });
  });

  test("92 hari diterima, 93 hari ditolak", async () => {
    await get("summary", `from=${geser(HARI, -91)}&to=${HARI}`).expect(200);
    await salah(`from=${geser(HARI, -92)}&to=${HARI}`, { to: ["Rentang maksimal 92 hari."] });
    await salah(`from=${geser(HARI, -92)}&to=${HARI}`, { to: ["Rentang maksimal 92 hari."] }, "transactions");
  });

  test("tanggal setelah hari ini", async () => {
    await salah(`from=${HARI}&to=${geser(HARI, 1)}`, { to: ["Tanggal tidak boleh melewati hari ini."] });
  });

  test("tanggal awal di masa depan: from dan to sama-sama ditolak", async () => {
    const besok = geser(HARI, 1);
    const pesan = ["Tanggal tidak boleh melewati hari ini."];
    await salah(`from=${besok}&to=${besok}`, { from: pesan, to: pesan });
    await salah(`from=${besok}&to=${besok}`, { from: pesan, to: pesan }, "transactions");
  });

  test("token pembeli → 403, tanpa token → 401", async () => {
    await get("summary", `from=${HARI}&to=${HARI}`, setup.customerToken).expect(403);
    await get("transactions", `from=${HARI}&to=${HARI}`, setup.customerToken).expect(403);
    await request(app).get(`/api/v1/merchant/reports/summary?from=${HARI}&to=${HARI}`).expect(401);
  });
});

describe("GET /merchant/reports/hourly", () => {
  const hourly = (date: string, token = setup.tokenA) => get("hourly", `date=${date}`, token);

  test("hanya jam bertransaksi, urut naik; Σ revenue semua jam = summary.revenue; toko B & status lain tidak ikut", async () => {
    const res = await hourly(HOURLY_TEST_DAY).expect(200);
    expect(res.body.data).toEqual([
      { hour: 0, orders: 1, portions: 1, revenue: 5000 },
      { hour: 8, orders: 2, portions: 6, revenue: 50000 },
      { hour: 12, orders: 1, portions: 1, revenue: 5000 },
      { hour: 23, orders: 1, portions: 1, revenue: 5000 },
    ]);
    const total = res.body.data.reduce((sum: number, hourRow: any) => sum + hourRow.revenue, 0);
    expect(total).toBe((await ringkasan(HOURLY_TEST_DAY).expect(200)).body.data.revenue);
  });

  test("hari tanpa transaksi → []", async () => {
    expect((await hourly("2026-01-01").expect(200)).body.data).toEqual([]);
  });

  test("date tidak sah / hilang / masa depan → 400", async () => {
    await salahTanggal("date=2026-13-01", ["Tanggal tidak valid."]);
    await salahTanggal("", ["Tanggal tidak valid."]);
    await salahTanggal(`date=${geser(HARI, 1)}`, ["Tanggal tidak boleh melewati hari ini."]);
  });

  test("token pembeli → 403", async () => {
    await hourly(HARI, setup.customerToken).expect(403);
  });
});
