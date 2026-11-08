import request from "supertest";
import { beforeEach, expect, test } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { hariIniWib } from "../src/services/merchant-kuota.service";
import { menuRow, siapkanToko, sisipMenu } from "./helpers/toko";

let tA: string, tB: string, idA: number, idB: number;
let aktif: number, nonaktif: number, terhapus: number, milikB: number;

const get = (u: string, t = tA) => request(app).get(`/api/v1/merchant${u}`).set("Authorization", `Bearer ${t}`);
const KUNCI = [
  "available", "category", "daily_quota", "description", "held_today", "hpp", "id", "image_url", "is_active", "is_preorder", "margin",
  "min_order_qty", "name", "options", "preorder_days", "prep_minutes", "price", "quota_today", "rating_avg", "rating_count",
  "sold_today", "unit_label",
];

beforeEach(async () => {
  ({ tA, tB, idA, idB } = await siapkanToko());
  aktif = await sisipMenu(idA, { name: "Nasi Ayam", quota_today: 20, sold_today: 3, held_today: 2, rating_avg: 4.5, rating_count: 2 });
  nonaktif = await sisipMenu(idA, { name: "Es Teh", category_id: 5, is_active: false });
  terhapus = await sisipMenu(idA, { name: "Lama", deleted_at: "2026-01-01 00:00:00" });
  milikB = await sisipMenu(idB, { name: "Punya B" });
  await db.query("INSERT INTO menu_options (menu_id, name, extra_price, is_active) VALUES (?, 'Keju', 3000, TRUE), (?, 'Basi', 0, FALSE)", [aktif, aktif]);
});

test("DELETE /api/menus/1 dengan token penjual → 404 (router lama dihapus)", async () => {
  expect((await request(app).delete("/api/menus/1").set("Authorization", `Bearer ${tA}`)).status).toBe(404);
});

test("GET /merchant/menus: milik sendiri saja, urut id DESC, bentuk D3", async () => {
  const r = await get("/menus").expect(200);
  expect(r.body.data.map((m: any) => m.id)).toEqual([nonaktif, aktif]);
  const m = r.body.data[1];
  expect(Object.keys(m).sort()).toEqual(KUNCI);
  expect(m).toMatchObject({
    name: "Nasi Ayam", category: { id: 1, name: "Nasi Box", slug: "nasi-box" }, price: 15000, hpp: 9000, margin: 6000,
    quota_today: 20, sold_today: 3, held_today: 2, available: 15, is_active: true, is_preorder: false, rating_avg: 4.5, rating_count: 2,
  });
  expect(m.options).toEqual([{ id: expect.any(Number), name: "Keju", extra_price: 3000 }]);
  expect(r.body.data[0]).toMatchObject({ is_active: false, options: [] });
});

test("filter status, q (escape), kategori", async () => {
  const low = await sisipMenu(idA, { name: "Sisa Dua", quota_today: 5, sold_today: 3 });
  const habis = await sisipMenu(idA, { name: "Habis", quota_today: 4, sold_today: 2, held_today: 2 });
  const ids = async (q: string) => (await get(`/menus${q}`).expect(200)).body.data.map((m: any) => m.id);
  expect(await ids("?status=inactive")).toEqual([nonaktif]);
  expect(await ids("?status=low")).toEqual([low]);
  expect(await ids("?status=sold_out")).toEqual([habis]);
  expect(await ids("?status=active")).toEqual([habis, low, aktif]);
  const bad = await get("/menus?status=x").expect(400);
  expect(bad.body.error.fields.status).toEqual(["Status tidak dikenal."]);
  expect(await ids("?q=50%25")).toEqual([]);
  expect(await ids("?q=_")).toEqual([]);
  expect(await ids("?q=ayam")).toEqual([aktif]);
  await sisipMenu(idA, { name: "Donat Danus", category_id: 7 });
  expect((await get("/menus?category=danusan").expect(200)).body.data.map((m: any) => m.name)).toEqual(["Donat Danus"]);
});

test("GET /merchant/menus/:id: milik sendiri 200; lainnya 404 seragam", async () => {
  const r = await get(`/menus/${aktif}`).expect(200);
  expect(Object.keys(r.body.data).sort()).toEqual(KUNCI);
  expect(r.body.data.id).toBe(aktif);
  for (const id of [milikB, terhapus, "abc", "0", "1.5"]) {
    const x = await get(`/menus/${id}`).expect(404);
    expect(x.body.error).toMatchObject({ code: "NOT_FOUND", message: "Menu tidak ditemukan." });
  }
  expect((await get(`/menus/${milikB}`, tB).expect(200)).body.data.name).toBe("Punya B");
});

test("R-12: stock_date lama direset saat dibaca tanpa menggeser updated_at; toko lain tidak", async () => {
  const lama = { stock_date: "2000-01-01", daily_quota: 20, quota_today: 5, sold_today: 3, held_today: 1, updated_at: "2026-01-01 00:00:00" };
  const id = await sisipMenu(idA, lama);
  const idLainB = await sisipMenu(idB, lama);
  const r = await get(`/menus/${id}`).expect(200);
  expect(r.body.data).toMatchObject({ quota_today: 20, sold_today: 0, held_today: 0, available: 20 });
  const [[d]] = await db.query<any[]>("SELECT DATE_FORMAT(stock_date, '%Y-%m-%d') AS s, updated_at FROM menus WHERE id = ?", [id]);
  expect(d.s).toBe(hariIniWib());
  expect(d.updated_at.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  expect(await menuRow(idLainB)).toMatchObject({ quota_today: 5, sold_today: 3, held_today: 1 });
});

// TiDB memakai utf8mb4_bin secara bawaan: pencarian harus tetap tak peka huruf
test("q tak peka huruf walau kolom berkolasi biner", async () => {
  await db.query("ALTER TABLE menus MODIFY name VARCHAR(80) NOT NULL COLLATE utf8mb4_bin");
  expect((await get("/menus?q=AYAM").expect(200)).body.data.map((m: any) => m.id)).toEqual([aktif]);
});
