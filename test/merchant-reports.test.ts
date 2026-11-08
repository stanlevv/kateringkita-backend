import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { hariIniWib } from "../src/merchant/kuota";
import { rentangUtc } from "../src/laporan/service";
import { pesanDulu, siapCheckout, sisipMenu, tampilkan } from "./helpers/toko";

// F09: /merchant/reports/* (M-09, R-10; D1–D9)
let s: Awaited<ReturnType<typeof siapCheckout>>;
const k: Record<string, string> = {};

const atur = (code: string, o: Record<string, unknown>) => db.query("UPDATE orders SET ? WHERE code = ?", [o, code]);
const wib = (d: string, hms: string) => new Date(Date.parse(`${d}T${hms}+07:00`));
const geser = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
const HARI = hariIniWib();
const H = "2026-03-20"; // hari uji laporan per jam; completed_at disimpan UTC (WIB − 7 jam)
// Hari uji tetap di masa lalu: batas WIB sama dengan "kemarin 17:30 UTC = hari ini 00:30 WIB" tanpa mencemari data hari ini
const D = "2026-03-10";
const get = (jalur: string, qs: string, token = s.tA) => request(app).get(`/api/v1/merchant/reports/${jalur}?${qs}`).set("Authorization", `Bearer ${token}`);
const ringkasan = (from: string, to = from) => get("summary", `from=${from}&to=${to}`);
const salahTanggal = async (qs: string, pesan: string[]) => {
  const r = await get("hourly", qs).expect(400);
  expect(r.body.error).toMatchObject({ code: "VALIDATION_ERROR", message: "Data tidak valid.", fields: { date: pesan } });
  expect(Object.keys(r.body.error.fields)).toEqual(["date"]);
};
const KUNCI_TRX = ["code", "completed_at", "created_at", "customer_name", "hpp_total", "menu_name", "payment_method", "qty", "status", "total"];

// pesanan dua menu: 2× Nasi Ayam (15.000/HPP 9.000) + 1× Es Teh (5.000/HPP 2.000)
async function pesanDua(token: string): Promise<string> {
  const r = await request(app).post("/api/v1/orders").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", randomUUID())
    .send({ items: [{ menu_id: s.menu, qty: 2 }, { menu_id: s.menu2, qty: 1 }], pickup_point_id: 1, payment_method: "cod" }).expect(201);
  return r.body.data.code;
}

beforeAll(async () => {
  s = await siapCheckout();
  await tampilkan(s.idB);
  await db.query("INSERT INTO merchant_pickup_points (merchant_id, pickup_point_id) VALUES (?, 1)", [s.idB]);
  const menuB = await sisipMenu(s.idB, { name: "Soto" });
  const pagi = wib(HARI, "09:00:00");
  const siang = wib(HARI, "12:00:00");
  k.multi = await pesanDua(s.tCust);
  await atur(k.multi, { status: "completed", completed_at: pagi });
  k.satu = await pesanDulu(s.tCust, s.menu2, 3);
  await atur(k.satu, { status: "completed", completed_at: siang });
  // tiga status lain punya item dan completed_at, tetap tidak boleh dihitung (D1)
  for (const status of ["cancelled", "expired", "ready"]) {
    k[status] = await pesanDulu(s.tCust, s.menu);
    await atur(k[status], { status, completed_at: siang });
  }
  k.b = await pesanDulu(s.tCust, menuB, 4);
  await atur(k.b, { status: "completed", completed_at: siang });

  // fixture per jam di hari uji tersendiri (WIB = UTC + 7)
  const a = await pesanDua(s.tCust); // 2× Nasi Ayam 30.000 + 1× Es Teh 5.000, 08.10 WIB
  await atur(a, { status: "completed", completed_at: new Date(`${H}T01:10:00Z`) });
  const b = await pesanDulu(s.tCust, s.menu2, 3); // 15.000, 08.50 WIB (jam yang sama)
  await atur(b, { status: "completed", completed_at: new Date(`${H}T01:50:00Z`) });
  const c = await pesanDulu(s.tCust, s.menu2, 1); // 5.000, 12.05 WIB
  await atur(c, { status: "completed", completed_at: new Date(`${H}T05:05:00Z`) });
  const tengahMalam = await pesanDulu(s.tCust, s.menu2); // 5.000, 00.20 WIB
  await atur(tengahMalam, { status: "completed", completed_at: new Date(`${geser(H, -1)}T17:20:00Z`) });
  const akhirHari = await pesanDulu(s.tCust, s.menu2); // 5.000, 23.59 WIB
  await atur(akhirHari, { status: "completed", completed_at: new Date(`${H}T16:59:00Z`) });
  const batal = await pesanDulu(s.tCust, s.menu2); // status lain, jam 20.00 WIB, tidak boleh muncul
  await atur(batal, { status: "cancelled", completed_at: new Date(`${H}T13:00:00Z`) });
  const tokoB = await pesanDulu(s.tCust, menuB, 4); // toko lain, jam 10.00 WIB, tidak boleh muncul
  await atur(tokoB, { status: "completed", completed_at: new Date(`${H}T03:00:00Z`) });
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("GET /merchant/reports/summary", () => {
  test("hari ini: revenue/hpp dari order_items pesanan selesai toko sendiri; status lain & toko B tidak ikut", async () => {
    const [[q]] = await db.query<any[]>(
      `SELECT SUM(oi.line_total) AS r, SUM(oi.hpp * oi.qty) AS h FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE o.merchant_id = ? AND o.status = 'completed' AND o.completed_at >= ? AND o.completed_at < ?`, [s.idA, ...rentangUtc(HARI, HARI)]);
    const r = await ringkasan(HARI).expect(200);
    expect(r.body.data).toEqual({ target: 0, revenue: 50000, hpp_total: 26000, profit: 24000, achievement_pct: 0, orders: 2 });
    expect(r.body.data.revenue).toBe(Number(q.r));
    expect(r.body.data.hpp_total).toBe(Number(q.h));
  });

  test("rentang tanpa pesanan selesai → semua 0", async () => {
    const r = await ringkasan("2026-01-01").expect(200);
    expect(r.body.data).toEqual({ target: 0, revenue: 0, hpp_total: 0, profit: 0, achievement_pct: 0, orders: 0 });
  });

  test("target = target harian × jumlah hari; achievement_pct dibulatkan, boleh > 100; target 0 → 0", async () => {
    await db.query("UPDATE merchants SET daily_revenue_target = 100000 WHERE id = ?", [s.idA]);
    const r = await ringkasan(geser(HARI, -2), HARI).expect(200);
    expect(r.body.data).toMatchObject({ target: 300000, revenue: 50000, achievement_pct: Math.round((50000 / 300000) * 100) });
    await db.query("UPDATE merchants SET daily_revenue_target = 20000 WHERE id = ?", [s.idA]);
    expect((await ringkasan(HARI).expect(200)).body.data).toMatchObject({ target: 20000, achievement_pct: 250 });
    await db.query("UPDATE merchants SET daily_revenue_target = 0 WHERE id = ?", [s.idA]);
    expect((await ringkasan(HARI).expect(200)).body.data).toMatchObject({ target: 0, achievement_pct: 0 });
  });

  test("tanggal = completed_at WIB: 00:30 WIB masuk hari itu, 23:59:59 WIB hari sebelumnya; pre-order dibuat sebelumnya masuk hari selesai", async () => {
    const hari = geser(D, -1);
    k.x = await pesanDulu(s.tCust, s.menu2); // 00:30 WIB tanggal D
    await atur(k.x, { status: "completed", completed_at: new Date(`${hari}T17:30:00Z`) });
    k.y = await pesanDulu(s.tCust, s.menu2); // 23:59:59 WIB tanggal D-1
    await atur(k.y, { status: "completed", completed_at: new Date(`${hari}T16:59:59Z`) });
    k.z = await pesanDulu(s.tCust, s.menu2); // dibuat D-2, selesai D
    await atur(k.z, { status: "completed", created_at: wib(geser(D, -2), "10:00:00"), completed_at: wib(D, "09:00:00") });
    expect((await ringkasan(D).expect(200)).body.data).toMatchObject({ revenue: 10000, orders: 2 });
    expect((await ringkasan(hari).expect(200)).body.data).toMatchObject({ revenue: 5000, orders: 1 });
    expect((await ringkasan(geser(D, -2)).expect(200)).body.data).toMatchObject({ revenue: 0, orders: 0 });
  });

  test("salinan order_items: harga/HPP menu diubah dan menu dihapus setelah selesai tidak mengubah angka", async () => {
    await db.query("UPDATE menus SET price = 90000, hpp = 80000, deleted_at = NOW() WHERE merchant_id = ?", [s.idA]);
    const r = await ringkasan(HARI).expect(200);
    expect(r.body.data).toMatchObject({ revenue: 50000, hpp_total: 26000, profit: 24000 });
  });
});

describe("GET /merchant/reports/transactions", () => {
  test("satu baris per item, kunci persis, urut completed_at terbaru; toko B & status lain tidak ikut", async () => {
    const r = await get("transactions", `from=${HARI}&to=${HARI}`).expect(200);
    for (const t of r.body.data) expect(Object.keys(t).sort()).toEqual(KUNCI_TRX);
    expect(r.body.data.map((t: any) => [t.code, t.menu_name])).toEqual([[k.satu, "Es Teh"], [k.multi, "Nasi Ayam"], [k.multi, "Es Teh"]]);
    expect(r.body.data[0]).toMatchObject({
      customer_name: "Budi", payment_method: "cod", qty: 3, total: 15000, hpp_total: 6000, status: "completed",
      completed_at: wib(HARI, "12:00:00").toISOString(),
    });
    expect(r.body.data[1]).toMatchObject({ qty: 2, total: 30000, hpp_total: 18000, completed_at: wib(HARI, "09:00:00").toISOString() });
    expect(typeof r.body.data[1].created_at).toBe("string");
  });

  test("rentang kosong → []", async () => {
    expect((await get("transactions", "from=2026-01-01&to=2026-01-01").expect(200)).body.data).toEqual([]);
  });
});

describe("validasi query (D9) & penjaga", () => {
  const salah = async (qs: string, fields: Record<string, string[]>, jalur = "summary") => {
    const r = await get(jalur, qs).expect(400);
    expect(r.body.error).toMatchObject({ code: "VALIDATION_ERROR", message: "Data tidak valid.", fields });
    expect(Object.keys(r.body.error.fields).sort()).toEqual(Object.keys(fields).sort());
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
    await get("summary", `from=${HARI}&to=${HARI}`, s.tCust).expect(403);
    await get("transactions", `from=${HARI}&to=${HARI}`, s.tCust).expect(403);
    await request(app).get(`/api/v1/merchant/reports/summary?from=${HARI}&to=${HARI}`).expect(401);
  });
});

describe("GET /merchant/reports/hourly", () => {
  const hourly = (date: string, token = s.tA) => get("hourly", `date=${date}`, token);

  test("hanya jam bertransaksi, urut naik; Σ revenue semua jam = summary.revenue; toko B & status lain tidak ikut", async () => {
    const r = await hourly(H).expect(200);
    expect(r.body.data).toEqual([
      { hour: 0, orders: 1, portions: 1, revenue: 5000 },
      { hour: 8, orders: 2, portions: 6, revenue: 50000 },
      { hour: 12, orders: 1, portions: 1, revenue: 5000 },
      { hour: 23, orders: 1, portions: 1, revenue: 5000 },
    ]);
    const total = r.body.data.reduce((n: number, j: any) => n + j.revenue, 0);
    expect(total).toBe((await ringkasan(H).expect(200)).body.data.revenue);
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
    await hourly(HARI, s.tCust).expect(403);
  });
});
