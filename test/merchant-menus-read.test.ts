import request from "supertest";
import { beforeEach, expect, test } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { getWibDate } from "../src/services/merchant-quota.service";
import { menuRow, prepareMerchants, insertMenu } from "./helpers/merchant";

let tokenA: string, tokenB: string, idA: number, idB: number;
let activeMenu: number, inactiveMenu: number, deletedMenu: number, otherMerchantMenu: number;

const get = (path: string, token = tokenA) =>
  request(app).get(`/api/v1/merchant${path}`).set("Authorization", `Bearer ${token}`);
const MENU_KEYS = [
  "available",
  "category",
  "daily_quota",
  "description",
  "gallery",
  "held_today",
  "hpp",
  "id",
  "image_url",
  "is_active",
  "is_preorder",
  "margin",
  "min_order_qty",
  "name",
  "options",
  "preorder_days",
  "prep_minutes",
  "price",
  "quota_today",
  "rating_avg",
  "rating_count",
  "sold_today",
  "unit_label",
];

beforeEach(async () => {
  ({ tokenA, tokenB, idA, idB } = await prepareMerchants());
  activeMenu = await insertMenu(idA, {
    name: "Nasi Ayam",
    quota_today: 20,
    sold_today: 3,
    held_today: 2,
    rating_avg: 4.5,
    rating_count: 2,
  });
  inactiveMenu = await insertMenu(idA, { name: "Es Teh", category_id: 5, is_active: false });
  deletedMenu = await insertMenu(idA, { name: "Lama", deleted_at: "2026-01-01 00:00:00" });
  otherMerchantMenu = await insertMenu(idB, { name: "Punya B" });
  await db.query(
    "INSERT INTO menu_options (menu_id, name, extra_price, is_active) VALUES (?, 'Keju', 3000, TRUE), (?, 'Basi', 0, FALSE)",
    [activeMenu, activeMenu],
  );
});

test("DELETE /api/menus/1 dengan token penjual → 404 (router lama dihapus)", async () => {
  expect((await request(app).delete("/api/menus/1").set("Authorization", `Bearer ${tokenA}`)).status).toBe(404);
});

test("GET /merchant/menus: milik sendiri saja, urut id DESC, bentuk respons menu", async () => {
  const res = await get("/menus").expect(200);
  expect(res.body.data.map((menu: any) => menu.id)).toEqual([inactiveMenu, activeMenu]);
  const menu = res.body.data[1];
  expect(Object.keys(menu).sort()).toEqual(MENU_KEYS);
  expect(menu).toMatchObject({
    name: "Nasi Ayam",
    category: { id: 1, name: "Nasi Box", slug: "nasi-box" },
    price: 15000,
    hpp: 9000,
    margin: 6000,
    quota_today: 20,
    sold_today: 3,
    held_today: 2,
    available: 15,
    is_active: true,
    is_preorder: false,
    rating_avg: 4.5,
    rating_count: 2,
  });
  expect(menu.options).toEqual([{ id: expect.any(Number), name: "Keju", extra_price: 3000 }]);
  expect(res.body.data[0]).toMatchObject({ is_active: false, options: [] });
});

test("filter status, q (escape), kategori", async () => {
  const low = await insertMenu(idA, { name: "Sisa Dua", quota_today: 5, sold_today: 3 });
  const soldOutMenu = await insertMenu(idA, { name: "Habis", quota_today: 4, sold_today: 2, held_today: 2 });
  const ids = async (query: string) => (await get(`/menus${query}`).expect(200)).body.data.map((menu: any) => menu.id);
  expect(await ids("?status=inactive")).toEqual([inactiveMenu]);
  expect(await ids("?status=low")).toEqual([low]);
  expect(await ids("?status=sold_out")).toEqual([soldOutMenu]);
  expect(await ids("?status=active")).toEqual([soldOutMenu, low, activeMenu]);
  const bad = await get("/menus?status=x").expect(400);
  expect(bad.body.error.fields.status).toEqual(["Status tidak dikenal."]);
  expect(await ids("?q=50%25")).toEqual([]);
  expect(await ids("?q=_")).toEqual([]);
  expect(await ids("?q=ayam")).toEqual([activeMenu]);
  await insertMenu(idA, { name: "Donat Danus", category_id: 7 });
  expect((await get("/menus?category=danusan").expect(200)).body.data.map((menu: any) => menu.name)).toEqual([
    "Donat Danus",
  ]);
});

test("GET /merchant/menus/:id: milik sendiri 200; lainnya 404 seragam", async () => {
  const res = await get(`/menus/${activeMenu}`).expect(200);
  expect(Object.keys(res.body.data).sort()).toEqual(MENU_KEYS);
  expect(res.body.data.id).toBe(activeMenu);
  for (const id of [otherMerchantMenu, deletedMenu, "abc", "0", "1.5"]) {
    const missingRes = await get(`/menus/${id}`).expect(404);
    expect(missingRes.body.error).toMatchObject({ code: "NOT_FOUND", message: "Menu tidak ditemukan." });
  }
  expect((await get(`/menus/${otherMerchantMenu}`, tokenB).expect(200)).body.data.name).toBe("Punya B");
});

test("stock_date lama direset saat dibaca tanpa menggeser updated_at; toko lain tidak", async () => {
  const staleFields = {
    stock_date: "2000-01-01",
    daily_quota: 20,
    quota_today: 5,
    sold_today: 3,
    held_today: 1,
    updated_at: "2026-01-01 00:00:00",
  };
  const id = await insertMenu(idA, staleFields);
  const staleIdB = await insertMenu(idB, staleFields);
  const res = await get(`/menus/${id}`).expect(200);
  expect(res.body.data).toMatchObject({ quota_today: 20, sold_today: 0, held_today: 0, available: 20 });
  const [[row]] = await db.query<any[]>(
    "SELECT DATE_FORMAT(stock_date, '%Y-%m-%d') AS s, updated_at FROM menus WHERE id = ?",
    [id],
  );
  expect(row.s).toBe(getWibDate());
  expect(row.updated_at.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  expect(await menuRow(staleIdB)).toMatchObject({ quota_today: 5, sold_today: 3, held_today: 1 });
});

// TiDB memakai utf8mb4_bin secara bawaan: pencarian harus tetap tak peka huruf
test("q tak peka huruf walau kolom berkolasi biner", async () => {
  await db.query("ALTER TABLE menus MODIFY name VARCHAR(80) NOT NULL COLLATE utf8mb4_bin");
  expect((await get("/menus?q=AYAM").expect(200)).body.data.map((menu: any) => menu.id)).toEqual([activeMenu]);
});
