// Isi file: test laporan toko (GET /merchant/reports/summary, hourly, transactions) dari alur pesanan sungguhan:
// pesanan dibuat lewat checkout dan diselesaikan penjual lewat API (konfirmasi, masak, siap, selesai), lalu angka
// laporannya dicek. Bedanya dengan merchant-reports.test.ts: file itu mengatur status dan waktu pesanan langsung lewat
// SQL untuk menguji kasus tepi (batas hari WIB, salinan harga, kunci baris, validasi query) secara rinci.
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { getWibDate } from "../src/services/merchant-quota.service";
import { placeOrder, prepareCheckout } from "./helpers/merchant";

let setup: Awaited<ReturnType<typeof prepareCheckout>>;
let orderCode: string;
const today = getWibDate();
const get = (path: string, token = setup.tokenA) =>
  request(app).get(`/api/v1/merchant/reports/${path}`).set("Authorization", `Bearer ${token}`);
const completeOrder = async (code: string) => {
  for (const action of ["confirm", "cook", "ready", "complete"]) {
    await request(app)
      .post(`/api/v1/merchant/orders/${code}/${action}`)
      .set("Authorization", `Bearer ${setup.tokenA}`)
      .expect(200);
  }
};

beforeAll(async () => {
  setup = await prepareCheckout();
  await db.query("UPDATE merchants SET daily_revenue_target = 50000 WHERE id = ?", [setup.idA]);
  // pesanan 1: dua menu (Nasi Ayam ×2 = 30000, hpp 18000; Es Teh ×1 = 5000, hpp 2000)
  const res = await request(app)
    .post("/api/v1/orders")
    .set("Authorization", `Bearer ${setup.customerToken}`)
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
  orderCode = res.body.data.code;
  await completeOrder(orderCode);
  // pesanan 2: Es Teh ×1 selesai; pesanan 3 masih holding (tidak dihitung)
  await completeOrder(await placeOrder(setup.customerToken, setup.menu2));
  await placeOrder(setup.customerToken, setup.menu);
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("summary", () => {
  test("hanya completed; target = target harian × hari", async () => {
    const res = await get(`summary?from=${today}&to=${today}`).expect(200);
    expect(res.body.data).toEqual({
      target: 50000,
      revenue: 40000,
      hpp_total: 22000,
      profit: 18000,
      achievement_pct: 80,
      orders: 2,
    });
    const weekStart = new Date(Date.parse(`${today}T00:00:00Z`) - 6 * 86400e3).toISOString().slice(0, 10);
    expect((await get(`summary?from=${weekStart}&to=${today}`)).body.data).toMatchObject({ target: 350000, orders: 2 });
  });

  test("toko lain nol; target 0 → capaian 0", async () => {
    expect((await get(`summary?from=${today}&to=${today}`, setup.tokenB)).body.data).toEqual({
      target: 0,
      revenue: 0,
      hpp_total: 0,
      profit: 0,
      achievement_pct: 0,
      orders: 0,
    });
  });

  test("validasi rentang tanggal dan peran", async () => {
    const invalidRes = await get("summary?from=2026-01-10&to=2026-01-01").expect(400);
    expect(invalidRes.body.error.fields.to).toEqual(["Tanggal akhir harus setelah tanggal awal."]);
    expect((await get("summary?from=2026-01-01&to=2026-06-01").expect(400)).body.error.fields.to).toEqual([
      "Rentang maksimal 92 hari.",
    ]);
    expect((await get("summary?from=kemarin&to=2026-01-01").expect(400)).body.error.fields.from).toEqual([
      "Tanggal tidak valid.",
    ]);
    await get(`summary?from=${today}&to=${today}`, setup.customerToken).expect(403);
  });
});

describe("hourly & transactions", () => {
  test("per jam WIB: satu jam, 2 pesanan, 4 porsi", async () => {
    const res = await get(`hourly?date=${today}`).expect(200);
    const hour = new Date(Date.now() + 7 * 3600e3).getUTCHours();
    expect(res.body.data).toEqual([{ hour: hour, orders: 2, portions: 4, revenue: 40000 }]);
    await get("hourly").expect(400);
  });

  test("satu baris per menu, hpp per baris, tanpa pesanan holding", async () => {
    const res = await get(`transactions?from=${today}&to=${today}`).expect(200);
    expect(res.body.data).toHaveLength(3);
    const rows = res.body.data.filter((row: { code: string }) => row.code === orderCode);
    expect(rows.map((row: Record<string, unknown>) => [row.menu_name, row.qty, row.total, row.hpp_total])).toEqual([
      ["Nasi Ayam", 2, 30000, 18000],
      ["Es Teh", 1, 5000, 2000],
    ]);
    expect(rows[0]).toMatchObject({ customer_name: "Budi", payment_method: "cod", status: "completed" });
    expect(rows[0].completed_at).not.toBeNull();
  });
});
