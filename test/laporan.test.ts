import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { hariIniWib } from "../src/services/merchant-kuota.service";
import { pesanDulu, siapCheckout } from "./helpers/toko";

// F09: GET /merchant/reports/{summary,hourly,transactions} (LP-N1..N4, LP-E1)
let s: Awaited<ReturnType<typeof siapCheckout>>;
let kode: string;
const hariIni = hariIniWib();
const get = (path: string, token = s.tA) => request(app).get(`/api/v1/merchant/reports/${path}`).set("Authorization", `Bearer ${token}`);
const selesaikan = async (code: string) => {
  for (const a of ["confirm", "cook", "ready", "complete"]) {
    await request(app).post(`/api/v1/merchant/orders/${code}/${a}`).set("Authorization", `Bearer ${s.tA}`).expect(200);
  }
};

beforeAll(async () => {
  s = await siapCheckout();
  await db.query("UPDATE merchants SET daily_revenue_target = 50000 WHERE id = ?", [s.idA]);
  // pesanan 1: dua menu (Nasi Ayam ×2 = 30000, hpp 18000; Es Teh ×1 = 5000, hpp 2000)
  const r = await request(app).post("/api/v1/orders").set("Authorization", `Bearer ${s.tCust}`).set("Idempotency-Key", randomUUID())
    .send({ items: [{ menu_id: s.menu, qty: 2 }, { menu_id: s.menu2, qty: 1 }], pickup_point_id: 1, payment_method: "cod" }).expect(201);
  kode = r.body.data.code;
  await selesaikan(kode);
  // pesanan 2: Es Teh ×1 selesai; pesanan 3 masih holding (tidak dihitung)
  await selesaikan(await pesanDulu(s.tCust, s.menu2));
  await pesanDulu(s.tCust, s.menu);
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("summary", () => {
  test("hanya completed; target = target harian × hari", async () => {
    const r = await get(`summary?from=${hariIni}&to=${hariIni}`).expect(200);
    expect(r.body.data).toEqual({ target: 50000, revenue: 40000, hpp_total: 22000, profit: 18000, achievement_pct: 80, orders: 2 });
    const minggu = new Date(Date.parse(`${hariIni}T00:00:00Z`) - 6 * 86400e3).toISOString().slice(0, 10);
    expect((await get(`summary?from=${minggu}&to=${hariIni}`)).body.data).toMatchObject({ target: 350000, orders: 2 });
  });

  test("toko lain nol; target 0 → capaian 0", async () => {
    expect((await get(`summary?from=${hariIni}&to=${hariIni}`, s.tB)).body.data)
      .toEqual({ target: 0, revenue: 0, hpp_total: 0, profit: 0, achievement_pct: 0, orders: 0 });
  });

  test("validasi rentang (LP-E1) dan peran", async () => {
    const salah = await get("summary?from=2026-01-10&to=2026-01-01").expect(400);
    expect(salah.body.error.fields.to).toEqual(["Tanggal akhir harus setelah tanggal awal."]);
    expect((await get("summary?from=2026-01-01&to=2026-06-01").expect(400)).body.error.fields.to).toEqual(["Rentang maksimal 92 hari."]);
    expect((await get("summary?from=kemarin&to=2026-01-01").expect(400)).body.error.fields.from).toEqual(["Tanggal tidak valid."]);
    await get(`summary?from=${hariIni}&to=${hariIni}`, s.tCust).expect(403);
  });
});

describe("hourly & transactions", () => {
  test("per jam WIB: satu jam, 2 pesanan, 4 porsi", async () => {
    const r = await get(`hourly?date=${hariIni}`).expect(200);
    const jam = new Date(Date.now() + 7 * 3600e3).getUTCHours();
    expect(r.body.data).toEqual([{ hour: jam, orders: 2, portions: 4, revenue: 40000 }]);
    await get("hourly").expect(400);
  });

  test("satu baris per menu, hpp per baris, tanpa pesanan holding", async () => {
    const r = await get(`transactions?from=${hariIni}&to=${hariIni}`).expect(200);
    expect(r.body.data).toHaveLength(3);
    const baris = r.body.data.filter((t: { code: string }) => t.code === kode);
    expect(baris.map((t: Record<string, unknown>) => [t.menu_name, t.qty, t.total, t.hpp_total]))
      .toEqual([["Nasi Ayam", 2, 30000, 18000], ["Es Teh", 1, 5000, 2000]]);
    expect(baris[0]).toMatchObject({ customer_name: "Budi", payment_method: "cod", status: "completed" });
    expect(baris[0].completed_at).not.toBeNull();
  });
});
