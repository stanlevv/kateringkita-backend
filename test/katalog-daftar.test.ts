import request from "supertest";
import { beforeEach, expect, test } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { BOCOR, bekukanJam, siapkanToko, sisipMenu, tampilkan } from "./helpers/toko";

let idA: number, idB: number, slugA: string;
let ayam: number, esTeh: number;

const get = (u: string) => request(app).get(`/api/v1${u}`);
const ids = async (q = "") => (await get(`/menus${q}`).expect(200)).body.data.map((m: any) => m.id);
const KUNCI = ["available", "badge", "category", "id", "image_url", "is_favorite", "merchant", "name", "price", "rating_avg", "rating_count", "unit_label"];

beforeEach(async () => {
  bekukanJam();
  ({ idA, idB } = await siapkanToko());
  await tampilkan(idA);
  await tampilkan(idB);
  slugA = ((await db.query<any[]>("SELECT slug FROM merchants WHERE id = ?", [idA]))[0] as any[])[0].slug;
  ayam = await sisipMenu(idA, { name: "Nasi Ayam", quota_today: 20, sold_today: 3, held_today: 2, sold_total: 5 });
  await db.query("INSERT INTO menu_options (menu_id, name, extra_price) VALUES (?, 'Keju', 3000)", [ayam]);
  esTeh = await sisipMenu(idB, { name: "Es Teh", category_id: 5, price: 5000, hpp: 2000, sold_total: 1 });
});

test("GET /menus tanpa token: kartu D6, tanpa angka internal (R-11, BE-02)", async () => {
  const r = await get("/menus").expect(200);
  expect(r.body.meta).toEqual({ page: 1, limit: 20, total: 2 });
  expect(r.body.data.map((m: any) => m.id)).toEqual([ayam, esTeh]);
  const k = r.body.data[0];
  expect(Object.keys(k).sort()).toEqual(KUNCI);
  expect(k).toEqual({
    id: ayam, name: "Nasi Ayam", image_url: null, price: 15000, unit_label: "porsi",
    category: { id: 1, name: "Nasi Box", slug: "nasi-box" },
    merchant: { id: idA, slug: slugA, business_name: "Dapur Siti", is_open: true },
    available: 15, badge: "available", rating_avg: 0, rating_count: 0, is_favorite: false,
  });
  const s = JSON.stringify(r.body);
  for (const kunci of BOCOR) expect(s).not.toContain(kunci);
});

test("R-14: toko belum terverifikasi, pemilik nonaktif, menu nonaktif/terhapus tidak tampil", async () => {
  for (const st of ["pending", "needs_fix", "suspended"]) {
    await db.query("UPDATE merchants SET verification_status = ? WHERE id = ?", [st, idB]);
    expect(await ids()).toEqual([ayam]);
  }
  await db.query("UPDATE merchants SET verification_status = 'verified' WHERE id = ?", [idB]);
  await db.query("UPDATE users SET is_active = FALSE WHERE id = (SELECT user_id FROM merchants WHERE id = ?)", [idA]);
  expect(await ids()).toEqual([esTeh]);
  await db.query("UPDATE users SET is_active = TRUE");
  await sisipMenu(idA, { name: "Mati", is_active: false });
  await sisipMenu(idA, { name: "Hapus", deleted_at: "2026-01-01 00:00:00" });
  expect(await ids()).toEqual([ayam, esTeh]);
});

test("D2: toko tutup (saklar atau jam) tidak tampil; rentang lewat tengah malam dihormati", async () => {
  await db.query("UPDATE merchants SET is_open = FALSE WHERE id = ?", [idA]);
  expect(await ids()).toEqual([esTeh]);
  await tampilkan(idA, { buka: false });
  expect(await ids()).toEqual([esTeh]);
  await db.query("UPDATE merchants SET open_time = '22:00:00', close_time = '11:00:00' WHERE id = ?", [idA]);
  expect(await ids()).toEqual([ayam, esTeh]);
  // tepat jam tutup = tutup (sama dengan sedangBuka)
  await db.query("UPDATE merchants SET open_time = '07:00:00', close_time = '10:00:00' WHERE id = ?", [idA]);
  expect(await ids()).toEqual([esTeh]);
});

test("D2 ruling: filter merchant=<slug> tidak memakai syarat buka (profil toko tutup tetap berisi menu)", async () => {
  const habis = await sisipMenu(idA, { name: "Habis", quota_today: 5, sold_today: 5, sold_total: 999 });
  await db.query("UPDATE merchants SET is_open = FALSE WHERE id = ?", [idA]);
  const r = (await get(`/menus?merchant=${slugA}`).expect(200)).body;
  expect(r.data.map((m: any) => [m.id, m.merchant.is_open])).toEqual([[ayam, false], [habis, false]]);
  expect(r.meta.total).toBe(2);
  await tampilkan(idA, { buka: false });
  expect(await ids(`?merchant=${slugA}`)).toEqual([ayam, habis]);
  expect(await ids()).toEqual([esTeh]);
  await db.query("UPDATE merchants SET verification_status = 'suspended' WHERE id = ?", [idA]);
  expect(await ids(`?merchant=${slugA}`)).toEqual([]);
});

test("D4/D5: badge, habis paling akhir, reset harian tanpa menulis DB", async () => {
  const habis = await sisipMenu(idA, { name: "Habis", daily_quota: 10, quota_today: 10, sold_today: 10, sold_total: 999 });
  const sedikit = await sisipMenu(idA, { name: "Sedikit", quota_today: 7 });
  const po = await sisipMenu(idA, { name: "PO", is_preorder: true, preorder_days: 2 });
  // TiDB tidak menegakkan CHECK: tiru data rusak (ditahan melebihi sisa) dengan mematikan CHECK di MySQL uji
  const [[chk]] = await db.query<any[]>(
    "SELECT CONSTRAINT_NAME AS n FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND CHECK_CLAUSE LIKE '%held_today%'",
  );
  if (chk) await db.query(`ALTER TABLE menus ALTER CHECK \`${chk.n}\` NOT ENFORCED`);
  const rusak = await sisipMenu(idA, { name: "Rusak", quota_today: 5, sold_today: 3, held_today: 4 });
  const basi = await sisipMenu(idA, { name: "Basi", stock_date: "2000-01-01", daily_quota: 20, quota_today: 5, sold_today: 5 });
  const data = (await get("/menus").expect(200)).body.data;
  const by = (id: number) => data.find((m: any) => m.id === id);
  expect(by(habis)).toMatchObject({ available: 0, badge: "sold_out" });
  expect(by(sedikit)).toMatchObject({ available: 7, badge: "low_stock" });
  expect(by(po)).toMatchObject({ badge: "preorder" });
  expect(by(rusak)).toMatchObject({ available: 0, badge: "sold_out" });
  expect(by(basi)).toMatchObject({ available: 20, badge: "available" });
  expect(data.slice(-2).map((m: any) => m.id).sort()).toEqual([habis, rusak].sort());
  const [[row]] = await db.query<any[]>("SELECT DATE_FORMAT(stock_date, '%Y-%m-%d') AS s, quota_today, sold_today FROM menus WHERE id = ?", [basi]);
  expect(row).toEqual({ s: "2000-01-01", quota_today: 5, sold_today: 5 });
});

test("D8: q nama menu/toko dengan escape, kategori, toko, titik temu", async () => {
  expect(await ids("?q=ayam")).toEqual([ayam]);
  expect(await ids("?q=%20siti%20")).toEqual([ayam]);
  expect(await ids("?q=%25")).toEqual([]);
  expect(await ids("?q=_")).toEqual([]);
  expect(await ids("?q=%5C")).toEqual([]);
  const r = await get(`/menus?q=${"a".repeat(101)}`).expect(400);
  expect(r.body.error.fields.q).toEqual(["Pencarian maksimal 100 karakter."]);
  expect(await ids("?category=minuman")).toEqual([esTeh]);
  expect(await ids(`?merchant=${slugA}`)).toEqual([ayam]);
  expect(await ids("?category=tidak-ada")).toEqual([]);
  expect(await ids("?merchant=tidak-ada")).toEqual([]);
  await db.query("INSERT INTO merchant_pickup_points (merchant_id, pickup_point_id) VALUES (?, 1), (?, 2)", [idA, idB]);
  expect(await ids("?pickup_point_id=1")).toEqual([ayam]);
  await db.query("UPDATE pickup_points SET is_active = FALSE WHERE id = 1");
  expect(await ids("?pickup_point_id=1")).toEqual([]);
  for (const v of ["abc", "0", "1.5"]) {
    const bad = await get(`/menus?pickup_point_id=${v}`).expect(400);
    expect(bad.body.error.fields.pickup_point_id).toEqual(["Titik temu tidak valid."]);
  }
});

test("D9: urutan", async () => {
  const murah = await sisipMenu(idA, { name: "Murah", price: 2000, hpp: 1000, rating_avg: 4.5, rating_count: 9, sold_total: 3 });
  const mahal = await sisipMenu(idA, { name: "Mahal", price: 90000, hpp: 1000, rating_avg: 4.5, rating_count: 2, sold_total: 4 });
  expect(await ids()).toEqual([ayam, mahal, murah, esTeh]);
  expect(await ids("?sort=popular")).toEqual([ayam, mahal, murah, esTeh]);
  expect(await ids("?sort=price_asc")).toEqual([murah, esTeh, ayam, mahal]);
  expect(await ids("?sort=price_desc")).toEqual([mahal, ayam, esTeh, murah]);
  expect(await ids("?sort=rating")).toEqual([murah, mahal, esTeh, ayam]);
  expect(await ids("?sort=newest")).toEqual([mahal, murah, esTeh, ayam]);
  for (const v of ["x", "id;DROP TABLE menus"]) {
    const bad = await get(`/menus?sort=${encodeURIComponent(v)}`).expect(400);
    expect(bad.body.error.fields.sort).toEqual(["Urutan tidak dikenal."]);
  }
});

test("D10: pagination", async () => {
  await db.query("DELETE FROM menu_options");
  await db.query("DELETE FROM menus");
  for (let i = 0; i < 25; i++) await sisipMenu(idA, { name: `Menu ${i}` });
  const r = await get("/menus?limit=10&page=3").expect(200);
  expect(r.body.data).toHaveLength(5);
  expect(r.body.meta).toEqual({ page: 3, limit: 10, total: 25 });
  expect((await get("/menus?limit=500").expect(200)).body.meta.limit).toBe(100);
  expect((await get("/menus?page=0&limit=abc").expect(200)).body.meta).toEqual({ page: 1, limit: 20, total: 25 });
});

// TiDB memakai utf8mb4_bin secara bawaan: pencarian harus tetap tak peka huruf
test("q tak peka huruf walau kolom berkolasi biner", async () => {
  await db.query("ALTER TABLE menus MODIFY name VARCHAR(80) NOT NULL COLLATE utf8mb4_bin");
  await db.query("ALTER TABLE merchants MODIFY business_name VARCHAR(150) NOT NULL COLLATE utf8mb4_bin");
  expect(await ids("?q=AYAM")).toEqual([ayam]);
  expect(await ids("?q=dapur%20SITI")).toEqual([ayam]);
});
