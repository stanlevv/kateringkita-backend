import request from "supertest";
import { beforeEach, expect, test } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { BOCOR, bekukanJam, siapkanToko, sisipMenu, tampilkan } from "./helpers/toko";

let idA: number, idB: number, slugA: string, slugB: string, menu: number;

const get = (u: string) => request(app).get(`/api/v1${u}`);
const KUNCI = [
  "available", "badge", "category", "description", "id", "image_url", "is_favorite", "is_preorder", "merchant", "min_order_qty", "name",
  "options", "preorder_days", "prep_minutes", "price", "rating_avg", "rating_count", "unit_label",
];
const KUNCI_TOKO = ["business_name", "close_time", "id", "is_open", "logo_url", "open_time", "pickup_points", "slug"];
const KUNCI_PROFIL = [
  "business_name", "close_time", "description", "id", "is_favorite", "is_open", "logo_url", "merchant_type", "open_time", "pickup_points",
  "rating_avg", "rating_count", "slug",
];
const slug = async (id: number) => ((await db.query<any[]>("SELECT slug FROM merchants WHERE id = ?", [id]))[0] as any[])[0].slug as string;
const tolak = async (u: string, pesan = "Menu tidak ditemukan.") => {
  const r = await get(u).expect(404);
  expect(r.body.error.message).toBe(pesan);
};

beforeEach(async () => {
  bekukanJam();
  ({ idA, idB } = await siapkanToko());
  await tampilkan(idA);
  await tampilkan(idB);
  [slugA, slugB] = [await slug(idA), await slug(idB)];
  menu = await sisipMenu(idA, { name: "Nasi Ayam", description: "Pedas", quota_today: 20, sold_today: 3, prep_minutes: 20, min_order_qty: 2 });
  await db.query("INSERT INTO menu_options (menu_id, name, extra_price, is_active) VALUES (?, 'Keju', 3000, TRUE), (?, 'Basi', 0, FALSE)", [menu, menu]);
  await db.query("INSERT INTO merchant_pickup_points (merchant_id, pickup_point_id) VALUES (?, 1), (?, 2)", [idA, idA]);
  await db.query("UPDATE pickup_points SET is_active = FALSE, description = 'Tutup' WHERE id = 2");
  await db.query("UPDATE pickup_points SET description = 'Lobi' WHERE id = 1");
});

test("GET /menus/:id: bentuk D7, opsi & titik temu aktif saja, tanpa angka internal", async () => {
  const r = await get(`/menus/${menu}`).expect(200);
  const d = r.body.data;
  expect(Object.keys(d).sort()).toEqual(KUNCI);
  expect(Object.keys(d.merchant).sort()).toEqual(KUNCI_TOKO);
  expect(d).toMatchObject({
    id: menu, name: "Nasi Ayam", description: "Pedas", available: 17, badge: "available", is_preorder: false, preorder_days: 0,
    min_order_qty: 2, prep_minutes: 20, is_favorite: false, category: { id: 1, name: "Nasi Box", slug: "nasi-box" },
  });
  expect(d.options).toEqual([{ id: expect.any(Number), name: "Keju", extra_price: 3000 }]);
  expect(d.merchant).toEqual({
    id: idA, slug: slugA, business_name: "Dapur Siti", is_open: true, logo_url: null, open_time: "07:00", close_time: "16:00",
    pickup_points: [{ id: 1, name: "Gedung Vokasi UB (Lt. 2)", description: "Lobi" }],
  });
  const s = JSON.stringify(r.body);
  for (const k of BOCOR) expect(s).not.toContain(k);
});

test("D3: toko tutup (saklar atau jam) tetap 200 dengan is_open false", async () => {
  await db.query("UPDATE merchants SET is_open = FALSE WHERE id = ?", [idA]);
  expect((await get(`/menus/${menu}`).expect(200)).body.data.merchant.is_open).toBe(false);
  await tampilkan(idA, { buka: false });
  expect((await get(`/menus/${menu}`).expect(200)).body.data.merchant.is_open).toBe(false);
});

test("D1/BE-11: menu tersembunyi atau id tidak valid → 404", async () => {
  const mati = await sisipMenu(idA, { name: "Mati", is_active: false });
  const hapus = await sisipMenu(idA, { name: "Hapus", deleted_at: "2026-01-01 00:00:00" });
  for (const id of [mati, hapus, "abc", "0", "99999"]) await tolak(`/menus/${id}`);
  await db.query("UPDATE merchants SET verification_status = 'suspended' WHERE id = ?", [idA]);
  await tolak(`/menus/${menu}`);
  await db.query("UPDATE merchants SET verification_status = 'verified' WHERE id = ?", [idA]);
  await db.query("UPDATE users SET is_active = FALSE WHERE id = (SELECT user_id FROM merchants WHERE id = ?)", [idA]);
  await tolak(`/menus/${menu}`);
});

test("D5: stock_date lama → available = daily_quota", async () => {
  const basi = await sisipMenu(idA, { stock_date: "2000-01-01", daily_quota: 30, quota_today: 5, sold_today: 5 });
  expect((await get(`/menus/${basi}`).expect(200)).body.data).toMatchObject({ available: 30, badge: "available" });
});

test("D11: ulasan publik terbaru dulu, nama disamarkan, paginated", async () => {
  await db.query("INSERT INTO users (role, full_name, phone, password_hash) VALUES ('customer', ' Rahmawati ', '081200000001', 'x')");
  const [[rahma]] = await db.query<any[]>("SELECT id FROM users WHERE phone = '081200000001'");
  const [[budi]] = await db.query<any[]>("SELECT id FROM users WHERE email = 'budi@mail.com'");
  const ulas = async (i: number, uid: number, rating: number, at: string) => {
    const [o] = await db.query<any>(
      `INSERT INTO orders (code, customer_id, merchant_id, pickup_point_id, status, customer_name, customer_phone, subtotal, total,
        payment_method, hold_until) VALUES (?, ?, ?, 1, 'completed', 'x', 'x', 15000, 15000, 'cod', UTC_TIMESTAMP())`,
      [`KK-20260101-000${i}`, uid, idA],
    );
    await db.query("INSERT INTO reviews (order_id, menu_id, customer_id, rating, comment, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [o.insertId, menu, uid, rating, `ulasan ${i}`, at]);
  };
  await ulas(1, rahma.id, 5, "2026-01-01 01:00:00");
  await ulas(2, budi.id, 4, "2026-01-03 01:00:00");
  await ulas(3, rahma.id, 3, "2026-01-02 01:00:00");
  const r = await get(`/menus/${menu}/reviews`).expect(200);
  expect(r.body.meta).toEqual({ page: 1, limit: 20, total: 3 });
  expect(r.body.data).toEqual([
    { rating: 4, comment: "ulasan 2", customer_name: "Bu***", created_at: "2026-01-03T01:00:00.000Z" },
    { rating: 3, comment: "ulasan 3", customer_name: "Ra***", created_at: "2026-01-02T01:00:00.000Z" },
    { rating: 5, comment: "ulasan 1", customer_name: "Ra***", created_at: "2026-01-01T01:00:00.000Z" },
  ]);
  const p2 = await get(`/menus/${menu}/reviews?limit=2&page=2`).expect(200);
  expect(p2.body.data.map((u: any) => u.comment)).toEqual(["ulasan 1"]);
  const kosong = await sisipMenu(idA, { name: "Baru" });
  expect((await get(`/menus/${kosong}/reviews`).expect(200)).body).toEqual({ data: [], meta: { page: 1, limit: 20, total: 0 } });
  await tolak("/menus/abc/reviews");
  await db.query("UPDATE merchants SET verification_status = 'suspended' WHERE id = ?", [idA]);
  await tolak(`/menus/${menu}/reviews`);
});

test("D12: profil toko publik tanpa alamat/WA/status verifikasi", async () => {
  await db.query("UPDATE merchants SET description = 'Masakan rumah', rating_avg = 4.25, rating_count = 8 WHERE id = ?", [idA]);
  const r = await get(`/merchants/${slugA}`).expect(200);
  expect(Object.keys(r.body.data).sort()).toEqual(KUNCI_PROFIL);
  expect(r.body.data).toEqual({
    id: idA, slug: slugA, business_name: "Dapur Siti", description: "Masakan rumah", logo_url: null,
    merchant_type: { id: 1, name: "Katering Nasi Box & Harian" }, is_open: true, open_time: "07:00", close_time: "16:00",
    rating_avg: 4.25, rating_count: 8, pickup_points: [{ id: 1, name: "Gedung Vokasi UB (Lt. 2)", description: "Lobi" }], is_favorite: false,
  });
  const s = JSON.stringify(r.body);
  for (const k of [...BOCOR, '"verification_status"', '"user_id"']) expect(s).not.toContain(k);
  await db.query("UPDATE merchants SET is_open = FALSE WHERE id = ?", [idA]);
  expect((await get(`/merchants/${slugA}`).expect(200)).body.data.is_open).toBe(false);
  await db.query("UPDATE merchants SET verification_status = 'pending' WHERE id = ?", [idB]);
  await tolak(`/merchants/${slugB}`, "Toko tidak ditemukan.");
  await db.query("UPDATE users SET is_active = FALSE WHERE id = (SELECT user_id FROM merchants WHERE id = ?)", [idA]);
  await tolak(`/merchants/${slugA}`, "Toko tidak ditemukan.");
  await tolak("/merchants/tidak-ada", "Toko tidak ditemukan.");
});
