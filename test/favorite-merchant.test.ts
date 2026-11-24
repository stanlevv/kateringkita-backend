import request from "supertest";
import { beforeEach, expect, test } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { createAdmin } from "../src/scripts/create-admin";
import {
  PRIVATE_KEYS,
  freezeClock,
  login,
  createCustomer,
  prepareMerchants,
  insertMenu,
  makeVisible,
} from "./helpers/merchant";

// Favorit toko ("Dapur Favorit"): GET/PUT/DELETE /me/favorite-merchants + is_favorite di GET /merchants/:slug
let tokenA: string, customerToken: string, idA: number, idB: number, slugA: string, slugB: string;

const api = (method: "get" | "put" | "delete", path: string, token?: string) => {
  const req = request(app)[method](`/api/v1${path}`);
  return token ? req.set("Authorization", `Bearer ${token}`) : req;
};
const favIds = async (query = "", token = customerToken) =>
  (await api("get", `/me/favorite-merchants${query}`, token).expect(200)).body.data.map((merchant: any) => merchant.id);
const countRows = async () =>
  Number(((await db.query<any[]>("SELECT COUNT(*) AS n FROM merchant_favorites"))[0] as any[])[0].n);
const slug = async (id: number) =>
  ((await db.query<any[]>("SELECT slug FROM merchants WHERE id = ?", [id]))[0] as any[])[0].slug as string;
const setOwnerActive = (id: number, active: boolean) =>
  db.query("UPDATE users SET is_active = ? WHERE id = (SELECT user_id FROM merchants WHERE id = ?)", [active, id]);
const CARD_KEYS = [
  "business_name",
  "close_time",
  "cover_url",
  "description",
  "id",
  "is_favorite",
  "is_open",
  "logo_url",
  "merchant_type",
  "open_time",
  "pickup_points",
  "rating_avg",
  "rating_count",
  "slug",
];
const NOT_FOUND_ERROR = { code: "NOT_FOUND", message: "Toko tidak ditemukan." };

beforeEach(async () => {
  freezeClock();
  ({ tokenA, customerToken, idA, idB } = await prepareMerchants());
  await makeVisible(idA);
  await makeVisible(idB);
  [slugA, slugB] = [await slug(idA), await slug(idB)];
  // A: 1 titik temu; B: 2 aktif + 1 nonaktif → titik temu satu kueri untuk semua toko di halaman tetap terpisah per toko
  await db.query(
    "INSERT INTO merchant_pickup_points (merchant_id, pickup_point_id) VALUES (?, 1), (?, 2), (?, 3), (?, 1)",
    [idB, idB, idB, idA],
  );
  await db.query("UPDATE pickup_points SET is_active = FALSE WHERE id = 3");
});

test("PUT idempoten 204, GET kartu = profil GET /merchants/:slug, DELETE idempoten", async () => {
  const res = await api("put", `/me/favorite-merchants/${idA}`, customerToken).expect(204);
  expect(res.text).toBe("");
  await api("put", `/me/favorite-merchants/${idA}`, customerToken).expect(204);
  expect(await countRows()).toBe(1);
  await api("put", `/me/favorite-merchants/${idB}`, customerToken).expect(204);
  await db.query("UPDATE merchant_favorites SET created_at = '2026-01-01 00:00:00' WHERE merchant_id = ?", [idA]);
  await db.query("UPDATE merchant_favorites SET created_at = '2026-01-02 00:00:00' WHERE merchant_id = ?", [idB]);

  const listRes = await api("get", "/me/favorite-merchants", customerToken).expect(200);
  expect(listRes.body.meta).toEqual({ page: 1, limit: 20, total: 2 });
  expect(listRes.body.data.map((merchant: any) => merchant.id)).toEqual([idB, idA]);
  for (const merchantCard of listRes.body.data) expect(Object.keys(merchantCard).sort()).toEqual(CARD_KEYS);
  const profileA = (await api("get", `/merchants/${slugA}`, customerToken).expect(200)).body.data;
  const profileB = (await api("get", `/merchants/${slugB}`, customerToken).expect(200)).body.data;
  const withoutVouchers = ({ vouchers, ...card }: any) => (expect(vouchers).toEqual([]), card); // kartu favorit tanpa daftar voucher
  expect(listRes.body.data).toEqual([withoutVouchers(profileB), withoutVouchers(profileA)]);
  expect(profileA).toMatchObject({ id: idA, is_favorite: true, pickup_points: [{ id: 1 }] });
  expect(profileB.pickup_points.map((point: any) => point.id).sort()).toEqual([1, 2]);
  const json = JSON.stringify(listRes.body);
  for (const key of [...PRIVATE_KEYS, '"verification_status"', '"user_id"']) expect(json).not.toContain(key);

  await api("delete", `/me/favorite-merchants/${idA}`, customerToken).expect(204);
  expect(await countRows()).toBe(1);
  await api("delete", `/me/favorite-merchants/${idA}`, customerToken).expect(204);
  expect(await favIds()).toEqual([idB]);
  const bad = await api("delete", "/me/favorite-merchants/abc", customerToken).expect(404);
  expect(bad.body.error).toMatchObject(NOT_FOUND_ERROR);
});

test("PUT: toko tersembunyi/id tidak valid 404, toko tutup 204", async () => {
  await db.query("UPDATE merchants SET verification_status = 'suspended' WHERE id = ?", [idB]);
  for (const id of [idB, "abc", "0", "-1", "1.5", "99999"]) {
    const res = await api("put", `/me/favorite-merchants/${id}`, customerToken).expect(404);
    expect(res.body.error).toMatchObject(NOT_FOUND_ERROR);
  }
  await db.query("UPDATE merchants SET verification_status = 'pending' WHERE id = ?", [idB]);
  await api("put", `/me/favorite-merchants/${idB}`, customerToken).expect(404);
  await makeVisible(idB);
  await setOwnerActive(idB, false);
  await api("put", `/me/favorite-merchants/${idB}`, customerToken).expect(404);
  expect(await countRows()).toBe(0);
  await db.query("UPDATE merchants SET is_open = FALSE WHERE id = ?", [idA]);
  await api("put", `/me/favorite-merchants/${idA}`, customerToken).expect(204);
  await makeVisible(idA, { open: false });
  expect((await api("get", "/me/favorite-merchants", customerToken).expect(200)).body.data).toEqual([
    expect.objectContaining({ id: idA, is_open: false, is_favorite: true }),
  ]);
});

test("terbaru dulu, toko tersembunyi tidak tampil tapi barisnya tetap, paginated", async () => {
  // A difavoritkan lebih baru walau id-nya lebih kecil: urutan dari created_at, bukan id
  for (const [id, favoritedAt] of [
    [idA, "2026-01-03 00:00:00"],
    [idB, "2026-01-01 00:00:00"],
  ] as const) {
    await api("put", `/me/favorite-merchants/${id}`, customerToken).expect(204);
    await db.query("UPDATE merchant_favorites SET created_at = ? WHERE merchant_id = ?", [favoritedAt, id]);
  }
  expect(await favIds()).toEqual([idA, idB]);
  const page2 = await api("get", "/me/favorite-merchants?limit=1&page=2", customerToken).expect(200);
  expect(page2.body.data.map((merchant: any) => merchant.id)).toEqual([idB]);
  expect(page2.body.meta).toEqual({ page: 2, limit: 1, total: 2 });
  // Halaman tidak valid → bawaan, limit > 100 → 100
  expect((await api("get", "/me/favorite-merchants?page=x&limit=999", customerToken).expect(200)).body.meta).toEqual({
    page: 1,
    limit: 100,
    total: 2,
  });

  await db.query("UPDATE merchants SET verification_status = 'suspended' WHERE id = ?", [idA]);
  const res = await api("get", "/me/favorite-merchants", customerToken).expect(200);
  expect(res.body.data.map((merchant: any) => merchant.id)).toEqual([idB]);
  expect(res.body.meta.total).toBe(1);
  expect(await countRows()).toBe(2);
  await db.query("UPDATE merchants SET verification_status = 'verified' WHERE id = ?", [idA]);
  expect(await favIds()).toEqual([idA, idB]);
  await setOwnerActive(idB, false);
  expect(await favIds()).toEqual([idA]);
  await setOwnerActive(idB, true);
  expect(await favIds()).toEqual([idA, idB]);
  // menghapus favorit toko tersembunyi tetap bisa
  await db.query("UPDATE merchants SET verification_status = 'suspended' WHERE id = ?", [idB]);
  await api("delete", `/me/favorite-merchants/${idB}`, customerToken).expect(204);
  expect(await countRows()).toBe(1);
});

test("auth: tanpa token 401, penjual & admin 403, favorit per pembeli", async () => {
  await createAdmin({ phone: "081300000009", fullName: "Admin Uji", password: "rahasia123" });
  const adminToken = await login("081300000009");
  for (const [method, path] of [
    ["get", "/me/favorite-merchants"],
    ["put", `/me/favorite-merchants/${idA}`],
    ["delete", `/me/favorite-merchants/${idA}`],
  ] as const) {
    const unauthRes = await api(method, path).expect(401);
    expect(unauthRes.body.error.code).toBe("UNAUTHENTICATED");
    await api(method, path, "rusak").expect(401);
    for (const token of [tokenA, adminToken]) {
      const res = await api(method, path, token).expect(403);
      expect(res.body.error).toMatchObject({ code: "FORBIDDEN", message: "Anda tidak memiliki akses." });
    }
  }
  expect(await countRows()).toBe(0);
  const otherToken = await createCustomer(1);
  await api("put", `/me/favorite-merchants/${idA}`, otherToken).expect(204);
  expect(await favIds()).toEqual([]);
  expect(await favIds("", otherToken)).toEqual([idA]);
  await api("delete", `/me/favorite-merchants/${idA}`, customerToken).expect(204);
  expect(await favIds("", otherToken)).toEqual([idA]);
});

test("is_favorite di GET /merchants/:slug hanya untuk pembeli pemilik; tamu & peran lain tetap 200", async () => {
  await api("put", `/me/favorite-merchants/${idA}`, customerToken).expect(204);
  const isFavorite = async (slug: string, token?: string) =>
    (await api("get", `/merchants/${slug}`, token).expect(200)).body.data.is_favorite;
  expect(await isFavorite(slugA, customerToken)).toBe(true);
  expect(await isFavorite(slugB, customerToken)).toBe(false);
  expect(await isFavorite(slugA)).toBe(false);
  expect(await isFavorite(slugA, "rusak")).toBe(false);
  expect(await isFavorite(slugA, tokenA)).toBe(false);
  expect(await isFavorite(slugA, await createCustomer(1))).toBe(false);
  await api("get", `/merchants/${slugA}`).set("Authorization", "Basic xyz").expect(200);
  // favorit menu toko itu tidak membuat tokonya ikut favorit
  await api("delete", `/me/favorite-merchants/${idA}`, customerToken).expect(204);
  await api("put", `/me/favorites/${await insertMenu(idA)}`, customerToken).expect(204);
  expect(await isFavorite(slugA, customerToken)).toBe(false);
  await api("put", `/me/favorite-merchants/${idA}`, customerToken).expect(204);
  // toko tersembunyi tetap 404 walau difavoritkan
  await db.query("UPDATE merchants SET verification_status = 'suspended' WHERE id = ?", [idA]);
  const res = await api("get", `/merchants/${slugA}`, customerToken).expect(404);
  expect(res.body.error).toMatchObject(NOT_FOUND_ERROR);
  await db.query("UPDATE merchants SET verification_status = 'verified' WHERE id = ?", [idA]);
  await request(app).post("/api/v1/auth/logout").set("Authorization", `Bearer ${customerToken}`).expect(204);
  expect(await isFavorite(slugA, customerToken)).toBe(false);
});
