import request from "supertest";
import { beforeEach, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { BOCOR, bekukanJam, login, siapkanToko, sisipMenu, tampilkan } from "./helpers/toko";

let tA: string, tCust: string, idA: number, idB: number, a1: number, a2: number, b1: number;

const api = (method: "get" | "put" | "delete", u: string, t?: string) => {
  const r = request(app)[method](`/api/v1${u}`);
  return t ? r.set("Authorization", `Bearer ${t}`) : r;
};
const favIds = async (q = "", t = tCust) => (await api("get", `/me/favorites${q}`, t).expect(200)).body.data.map((m: any) => m.id);
const jumlahBaris = async () => Number(((await db.query<any[]>("SELECT COUNT(*) AS n FROM favorites"))[0] as any[])[0].n);
const KUNCI = ["available", "badge", "category", "id", "image_url", "is_favorite", "merchant", "name", "price", "rating_avg", "rating_count", "unit_label"];

beforeEach(async () => {
  bekukanJam();
  ({ tA, tCust, idA, idB } = await siapkanToko());
  await tampilkan(idA);
  await tampilkan(idB);
  a1 = await sisipMenu(idA, { name: "A1" });
  a2 = await sisipMenu(idA, { name: "A2" });
  b1 = await sisipMenu(idB, { name: "B1" });
});

test("PUT idempoten 204, GET kartu is_favorite true, DELETE idempoten", async () => {
  const r = await api("put", `/me/favorites/${a1}`, tCust).expect(204);
  expect(r.text).toBe("");
  await api("put", `/me/favorites/${a1}`, tCust).expect(204);
  expect(await jumlahBaris()).toBe(1);
  const g = await api("get", "/me/favorites", tCust).expect(200);
  expect(g.body.meta).toEqual({ page: 1, limit: 20, total: 1 });
  expect(Object.keys(g.body.data[0]).sort()).toEqual(KUNCI);
  expect(g.body.data[0]).toMatchObject({ id: a1, is_favorite: true });
  const s = JSON.stringify(g.body);
  for (const k of BOCOR) expect(s).not.toContain(k);
  await api("delete", `/me/favorites/${a1}`, tCust).expect(204);
  expect(await jumlahBaris()).toBe(0);
  await api("delete", `/me/favorites/${a1}`, tCust).expect(204);
  const bad = await api("delete", "/me/favorites/abc", tCust).expect(404);
  expect(bad.body.error.message).toBe("Menu tidak ditemukan.");
});

test("D14: is_favorite di katalog; token rusak/logout/penjual tidak 401", async () => {
  await api("put", `/me/favorites/${a1}`, tCust).expect(204);
  const fav = async (t?: string) => {
    const daftar = (await api("get", "/menus", t).expect(200)).body.data;
    const detail = (await api("get", `/menus/${a1}`, t).expect(200)).body.data;
    return { daftar: Object.fromEntries(daftar.map((m: any) => [m.id, m.is_favorite])), detail: detail.is_favorite };
  };
  expect(await fav(tCust)).toEqual({ daftar: { [a1]: true, [a2]: false, [b1]: false }, detail: true });
  const mati = { daftar: { [a1]: false, [a2]: false, [b1]: false }, detail: false };
  expect(await fav()).toEqual(mati);
  expect(await fav("abc")).toEqual(mati);
  expect(await fav(tA)).toEqual(mati);
  await api("get", "/menus").set("Authorization", "Basic xyz").expect(200);
  await request(app).post("/api/v1/auth/logout").set("Authorization", `Bearer ${tCust}`).expect(204);
  expect(await fav(tCust)).toEqual(mati);
});

test("D14: galat DB saat membaca sesi, akun nonaktif, sesi kedaluwarsa → katalog 200 sebagai tamu", async () => {
  await api("put", `/me/favorites/${a1}`, tCust).expect(204);
  const favA1 = async () => (await api("get", "/menus", tCust).expect(200)).body.data.find((m: any) => m.id === a1).is_favorite;
  expect(await favA1()).toBe(true);
  const asli = db.query.bind(db);
  const spy = vi.spyOn(db, "query").mockImplementation(((sql: any, ...rest: any[]) =>
    String(sql).includes("auth_sessions") ? Promise.reject(new Error("putus")) : (asli as any)(sql, ...rest)) as any);
  try {
    expect(await favA1()).toBe(false);
    await api("get", "/me/favorites", tCust).expect(500);
  } finally {
    spy.mockRestore();
  }
  await db.query("UPDATE auth_sessions SET expires_at = '2000-01-01 00:00:00'");
  expect(await favA1()).toBe(false);
  await db.query("UPDATE auth_sessions SET expires_at = '2999-01-01 00:00:00'");
  expect(await favA1()).toBe(true);
  await db.query("UPDATE users SET is_active = FALSE WHERE email = 'budi@mail.com'");
  expect(await favA1()).toBe(false);
});

test("PUT: menu tersembunyi/id tidak valid 404, toko tutup 204", async () => {
  const mati = await sisipMenu(idA, { name: "Mati", is_active: false });
  const hapus = await sisipMenu(idA, { name: "Hapus", deleted_at: "2026-01-01 00:00:00" });
  await db.query("UPDATE merchants SET verification_status = 'suspended' WHERE id = ?", [idB]);
  for (const id of [mati, hapus, b1, "abc", "0", "99999"]) {
    const r = await api("put", `/me/favorites/${id}`, tCust).expect(404);
    expect(r.body.error.message).toBe("Menu tidak ditemukan.");
  }
  await db.query("UPDATE merchants SET is_open = FALSE WHERE id = ?", [idA]);
  await api("put", `/me/favorites/${a1}`, tCust).expect(204);
  expect(await jumlahBaris()).toBe(1);
});

test("D13: hanya menu tampil, terbaru dulu, toko tutup & habis tetap ada, paginated", async () => {
  for (const [id, at] of [[a1, "2026-01-01 00:00:00"], [a2, "2026-01-02 00:00:00"], [b1, "2026-01-03 00:00:00"]]) {
    await api("put", `/me/favorites/${id}`, tCust).expect(204);
    await db.query("UPDATE favorites SET created_at = ? WHERE menu_id = ?", [at, id]);
  }
  expect(await favIds()).toEqual([b1, a2, a1]);
  await db.query("UPDATE menus SET is_active = FALSE WHERE id = ?", [a2]);
  const r = await api("get", "/me/favorites", tCust).expect(200);
  expect(r.body.data.map((m: any) => m.id)).toEqual([b1, a1]);
  expect(r.body.meta.total).toBe(2);
  await db.query("UPDATE menus SET is_active = TRUE WHERE id = ?", [a2]);
  expect(await favIds()).toEqual([b1, a2, a1]);
  await db.query("UPDATE menus SET is_active = FALSE WHERE id = ?", [a2]);
  await db.query("UPDATE merchants SET is_open = FALSE WHERE id = ?", [idA]);
  await db.query("UPDATE menus SET quota_today = 5, sold_today = 5 WHERE id = ?", [a1]);
  const g = (await api("get", "/me/favorites", tCust).expect(200)).body.data;
  expect(g.find((m: any) => m.id === a1)).toMatchObject({ badge: "sold_out", merchant: { is_open: false } });
  const p = await api("get", "/me/favorites?limit=1&page=2", tCust).expect(200);
  expect(p.body.data.map((m: any) => m.id)).toEqual([a1]);
  expect(p.body.meta).toEqual({ page: 2, limit: 1, total: 2 });
  await db.query("UPDATE merchants SET verification_status = 'suspended' WHERE id = ?", [idB]);
  expect(await favIds()).toEqual([a1]);
});

test("auth: tanpa token 401, penjual 403, favorit per pembeli", async () => {
  for (const [m, u] of [["get", "/me/favorites"], ["put", `/me/favorites/${a1}`], ["delete", `/me/favorites/${a1}`]] as const) {
    await api(m, u).expect(401);
    const r = await api(m, u, tA).expect(403);
    expect(r.body.error.message).toBe("Anda tidak memiliki akses.");
  }
  await request(app).post("/api/v1/auth/customer/register")
    .send({ full_name: "Citra", email: "citra@mail.com", phone: "081233334444", password: "rahasia123" }).expect(201);
  const tCitra = await login("citra@mail.com");
  await api("put", `/me/favorites/${a1}`, tCitra).expect(204);
  expect(await favIds()).toEqual([]);
  expect(await favIds("", tCitra)).toEqual([a1]);
  await api("delete", `/me/favorites/${a1}`, tCust).expect(204);
  expect(await favIds("", tCitra)).toEqual([a1]);
});
