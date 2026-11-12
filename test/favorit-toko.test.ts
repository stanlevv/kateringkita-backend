import request from "supertest";
import { beforeEach, expect, test } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { createAdmin } from "../src/scripts/create-admin";
import { BOCOR, bekukanJam, login, pembeliBaru, siapkanToko, sisipMenu, tampilkan } from "./helpers/toko";

// F05 favorit toko ("Dapur Favorit"): GET/PUT/DELETE /me/favorite-merchants + is_favorite di GET /merchants/:slug (D13, D14)
let tA: string, tCust: string, idA: number, idB: number, slugA: string, slugB: string;

const api = (method: "get" | "put" | "delete", u: string, t?: string) => {
  const r = request(app)[method](`/api/v1${u}`);
  return t ? r.set("Authorization", `Bearer ${t}`) : r;
};
const favIds = async (q = "", t = tCust) => (await api("get", `/me/favorite-merchants${q}`, t).expect(200)).body.data.map((m: any) => m.id);
const jumlahBaris = async () => Number(((await db.query<any[]>("SELECT COUNT(*) AS n FROM merchant_favorites"))[0] as any[])[0].n);
const slug = async (id: number) => ((await db.query<any[]>("SELECT slug FROM merchants WHERE id = ?", [id]))[0] as any[])[0].slug as string;
const pemilik = (id: number, aktif: boolean) =>
  db.query("UPDATE users SET is_active = ? WHERE id = (SELECT user_id FROM merchants WHERE id = ?)", [aktif, id]);
const KUNCI = [
  "business_name", "close_time", "description", "id", "is_favorite", "is_open", "logo_url", "merchant_type", "open_time", "pickup_points",
  "rating_avg", "rating_count", "slug",
];
const TIDAK_ADA = { code: "NOT_FOUND", message: "Toko tidak ditemukan." };

beforeEach(async () => {
  bekukanJam();
  ({ tA, tCust, idA, idB } = await siapkanToko());
  await tampilkan(idA);
  await tampilkan(idB);
  [slugA, slugB] = [await slug(idA), await slug(idB)];
  // A: 1 titik temu; B: 2 aktif + 1 nonaktif → titik temu satu kueri untuk semua toko di halaman tetap terpisah per toko
  await db.query("INSERT INTO merchant_pickup_points (merchant_id, pickup_point_id) VALUES (?, 1), (?, 2), (?, 3), (?, 1)", [idB, idB, idB, idA]);
  await db.query("UPDATE pickup_points SET is_active = FALSE WHERE id = 3");
});

test("PUT idempoten 204, GET kartu = profil GET /merchants/:slug, DELETE idempoten", async () => {
  const r = await api("put", `/me/favorite-merchants/${idA}`, tCust).expect(204);
  expect(r.text).toBe("");
  await api("put", `/me/favorite-merchants/${idA}`, tCust).expect(204);
  expect(await jumlahBaris()).toBe(1);
  await api("put", `/me/favorite-merchants/${idB}`, tCust).expect(204);
  await db.query("UPDATE merchant_favorites SET created_at = '2026-01-01 00:00:00' WHERE merchant_id = ?", [idA]);
  await db.query("UPDATE merchant_favorites SET created_at = '2026-01-02 00:00:00' WHERE merchant_id = ?", [idB]);

  const g = await api("get", "/me/favorite-merchants", tCust).expect(200);
  expect(g.body.meta).toEqual({ page: 1, limit: 20, total: 2 });
  expect(g.body.data.map((m: any) => m.id)).toEqual([idB, idA]);
  for (const k of g.body.data) expect(Object.keys(k).sort()).toEqual(KUNCI);
  const profilA = (await api("get", `/merchants/${slugA}`, tCust).expect(200)).body.data;
  const profilB = (await api("get", `/merchants/${slugB}`, tCust).expect(200)).body.data;
  expect(g.body.data).toEqual([profilB, profilA]);
  expect(profilA).toMatchObject({ id: idA, is_favorite: true, pickup_points: [{ id: 1 }] });
  expect(profilB.pickup_points.map((p: any) => p.id).sort()).toEqual([1, 2]);
  const s = JSON.stringify(g.body);
  for (const k of [...BOCOR, '"verification_status"', '"user_id"']) expect(s).not.toContain(k);

  await api("delete", `/me/favorite-merchants/${idA}`, tCust).expect(204);
  expect(await jumlahBaris()).toBe(1);
  await api("delete", `/me/favorite-merchants/${idA}`, tCust).expect(204);
  expect(await favIds()).toEqual([idB]);
  const bad = await api("delete", "/me/favorite-merchants/abc", tCust).expect(404);
  expect(bad.body.error).toMatchObject(TIDAK_ADA);
});

test("PUT: toko tersembunyi/id tidak valid 404, toko tutup 204", async () => {
  await db.query("UPDATE merchants SET verification_status = 'suspended' WHERE id = ?", [idB]);
  for (const id of [idB, "abc", "0", "-1", "1.5", "99999"]) {
    const r = await api("put", `/me/favorite-merchants/${id}`, tCust).expect(404);
    expect(r.body.error).toMatchObject(TIDAK_ADA);
  }
  await db.query("UPDATE merchants SET verification_status = 'pending' WHERE id = ?", [idB]);
  await api("put", `/me/favorite-merchants/${idB}`, tCust).expect(404);
  await tampilkan(idB);
  await pemilik(idB, false);
  await api("put", `/me/favorite-merchants/${idB}`, tCust).expect(404);
  expect(await jumlahBaris()).toBe(0);
  await db.query("UPDATE merchants SET is_open = FALSE WHERE id = ?", [idA]);
  await api("put", `/me/favorite-merchants/${idA}`, tCust).expect(204);
  await tampilkan(idA, { buka: false });
  expect((await api("get", "/me/favorite-merchants", tCust).expect(200)).body.data).toEqual([
    expect.objectContaining({ id: idA, is_open: false, is_favorite: true }),
  ]);
});

test("D13: terbaru dulu, toko tersembunyi tidak tampil tapi barisnya tetap, paginated", async () => {
  // A difavoritkan lebih baru walau id-nya lebih kecil: urutan dari created_at, bukan id
  for (const [id, at] of [[idA, "2026-01-03 00:00:00"], [idB, "2026-01-01 00:00:00"]] as const) {
    await api("put", `/me/favorite-merchants/${id}`, tCust).expect(204);
    await db.query("UPDATE merchant_favorites SET created_at = ? WHERE merchant_id = ?", [at, id]);
  }
  expect(await favIds()).toEqual([idA, idB]);
  const p = await api("get", "/me/favorite-merchants?limit=1&page=2", tCust).expect(200);
  expect(p.body.data.map((m: any) => m.id)).toEqual([idB]);
  expect(p.body.meta).toEqual({ page: 2, limit: 1, total: 2 });
  // D10: halaman tidak valid → bawaan, limit > 100 → 100
  expect((await api("get", "/me/favorite-merchants?page=x&limit=999", tCust).expect(200)).body.meta).toEqual({ page: 1, limit: 100, total: 2 });

  await db.query("UPDATE merchants SET verification_status = 'suspended' WHERE id = ?", [idA]);
  const r = await api("get", "/me/favorite-merchants", tCust).expect(200);
  expect(r.body.data.map((m: any) => m.id)).toEqual([idB]);
  expect(r.body.meta.total).toBe(1);
  expect(await jumlahBaris()).toBe(2);
  await db.query("UPDATE merchants SET verification_status = 'verified' WHERE id = ?", [idA]);
  expect(await favIds()).toEqual([idA, idB]);
  await pemilik(idB, false);
  expect(await favIds()).toEqual([idA]);
  await pemilik(idB, true);
  expect(await favIds()).toEqual([idA, idB]);
  // menghapus favorit toko tersembunyi tetap bisa
  await db.query("UPDATE merchants SET verification_status = 'suspended' WHERE id = ?", [idB]);
  await api("delete", `/me/favorite-merchants/${idB}`, tCust).expect(204);
  expect(await jumlahBaris()).toBe(1);
});

test("auth: tanpa token 401, penjual & admin 403, favorit per pembeli", async () => {
  await createAdmin({ phone: "081300000009", fullName: "Admin Uji", password: "rahasia123" });
  const tAdmin = await login("081300000009");
  for (const [m, u] of [["get", "/me/favorite-merchants"], ["put", `/me/favorite-merchants/${idA}`], ["delete", `/me/favorite-merchants/${idA}`]] as const) {
    const t = await api(m, u).expect(401);
    expect(t.body.error.code).toBe("UNAUTHENTICATED");
    await api(m, u, "rusak").expect(401);
    for (const tok of [tA, tAdmin]) {
      const r = await api(m, u, tok).expect(403);
      expect(r.body.error).toMatchObject({ code: "FORBIDDEN", message: "Anda tidak memiliki akses." });
    }
  }
  expect(await jumlahBaris()).toBe(0);
  const tLain = await pembeliBaru(1);
  await api("put", `/me/favorite-merchants/${idA}`, tLain).expect(204);
  expect(await favIds()).toEqual([]);
  expect(await favIds("", tLain)).toEqual([idA]);
  await api("delete", `/me/favorite-merchants/${idA}`, tCust).expect(204);
  expect(await favIds("", tLain)).toEqual([idA]);
});

test("D14: is_favorite di GET /merchants/:slug hanya untuk pembeli pemilik; tamu & peran lain tetap 200", async () => {
  await api("put", `/me/favorite-merchants/${idA}`, tCust).expect(204);
  const fav = async (s: string, t?: string) => (await api("get", `/merchants/${s}`, t).expect(200)).body.data.is_favorite;
  expect(await fav(slugA, tCust)).toBe(true);
  expect(await fav(slugB, tCust)).toBe(false);
  expect(await fav(slugA)).toBe(false);
  expect(await fav(slugA, "rusak")).toBe(false);
  expect(await fav(slugA, tA)).toBe(false);
  expect(await fav(slugA, await pembeliBaru(1))).toBe(false);
  await api("get", `/merchants/${slugA}`).set("Authorization", "Basic xyz").expect(200);
  // favorit menu toko itu tidak membuat tokonya ikut favorit
  await api("delete", `/me/favorite-merchants/${idA}`, tCust).expect(204);
  await api("put", `/me/favorites/${await sisipMenu(idA)}`, tCust).expect(204);
  expect(await fav(slugA, tCust)).toBe(false);
  await api("put", `/me/favorite-merchants/${idA}`, tCust).expect(204);
  // toko tersembunyi tetap 404 walau difavoritkan
  await db.query("UPDATE merchants SET verification_status = 'suspended' WHERE id = ?", [idA]);
  const r = await api("get", `/merchants/${slugA}`, tCust).expect(404);
  expect(r.body.error).toMatchObject(TIDAK_ADA);
  await db.query("UPDATE merchants SET verification_status = 'verified' WHERE id = ?", [idA]);
  await request(app).post("/api/v1/auth/logout").set("Authorization", `Bearer ${tCust}`).expect(204);
  expect(await fav(slugA, tCust)).toBe(false);
});
