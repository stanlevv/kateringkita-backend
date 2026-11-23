import request from "supertest";
import { beforeEach, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { PRIVATE_KEYS, freezeClock, login, prepareMerchants, insertMenu, makeVisible } from "./helpers/merchant";

let tokenA: string, customerToken: string, idA: number, idB: number, menuA1: number, menuA2: number, menuB1: number;

const api = (method: "get" | "put" | "delete", path: string, token?: string) => {
  const req = request(app)[method](`/api/v1${path}`);
  return token ? req.set("Authorization", `Bearer ${token}`) : req;
};
const favIds = async (query = "", token = customerToken) =>
  (await api("get", `/me/favorites${query}`, token).expect(200)).body.data.map((menu: any) => menu.id);
const countRows = async () => Number(((await db.query<any[]>("SELECT COUNT(*) AS n FROM favorites"))[0] as any[])[0].n);
const CARD_KEYS = [
  "available",
  "badge",
  "category",
  "id",
  "image_url",
  "is_favorite",
  "merchant",
  "name",
  "price",
  "rating_avg",
  "rating_count",
  "unit_label",
];

beforeEach(async () => {
  freezeClock();
  ({ tokenA, customerToken, idA, idB } = await prepareMerchants());
  await makeVisible(idA);
  await makeVisible(idB);
  menuA1 = await insertMenu(idA, { name: "A1" });
  menuA2 = await insertMenu(idA, { name: "A2" });
  menuB1 = await insertMenu(idB, { name: "B1" });
});

test("PUT idempoten 204, GET kartu is_favorite true, DELETE idempoten", async () => {
  const res = await api("put", `/me/favorites/${menuA1}`, customerToken).expect(204);
  expect(res.text).toBe("");
  await api("put", `/me/favorites/${menuA1}`, customerToken).expect(204);
  expect(await countRows()).toBe(1);
  const listRes = await api("get", "/me/favorites", customerToken).expect(200);
  expect(listRes.body.meta).toEqual({ page: 1, limit: 20, total: 1 });
  expect(Object.keys(listRes.body.data[0]).sort()).toEqual(CARD_KEYS);
  expect(listRes.body.data[0]).toMatchObject({ id: menuA1, is_favorite: true });
  const json = JSON.stringify(listRes.body);
  for (const key of PRIVATE_KEYS) expect(json).not.toContain(key);
  await api("delete", `/me/favorites/${menuA1}`, customerToken).expect(204);
  expect(await countRows()).toBe(0);
  await api("delete", `/me/favorites/${menuA1}`, customerToken).expect(204);
  const bad = await api("delete", "/me/favorites/abc", customerToken).expect(404);
  expect(bad.body.error.message).toBe("Menu tidak ditemukan.");
});

test("is_favorite di katalog; token rusak/logout/penjual tidak 401", async () => {
  await api("put", `/me/favorites/${menuA1}`, customerToken).expect(204);
  const favoriteState = async (token?: string) => {
    const menus = (await api("get", "/menus", token).expect(200)).body.data;
    const detail = (await api("get", `/menus/${menuA1}`, token).expect(200)).body.data;
    return {
      daftar: Object.fromEntries(menus.map((menu: any) => [menu.id, menu.is_favorite])),
      detail: detail.is_favorite,
    };
  };
  expect(await favoriteState(customerToken)).toEqual({
    daftar: { [menuA1]: true, [menuA2]: false, [menuB1]: false },
    detail: true,
  });
  const allFalse = { daftar: { [menuA1]: false, [menuA2]: false, [menuB1]: false }, detail: false };
  expect(await favoriteState()).toEqual(allFalse);
  expect(await favoriteState("abc")).toEqual(allFalse);
  expect(await favoriteState(tokenA)).toEqual(allFalse);
  await api("get", "/menus").set("Authorization", "Basic xyz").expect(200);
  await request(app).post("/api/v1/auth/logout").set("Authorization", `Bearer ${customerToken}`).expect(204);
  expect(await favoriteState(customerToken)).toEqual(allFalse);
});

test("galat DB saat membaca sesi, akun nonaktif, sesi kedaluwarsa → katalog 200 sebagai tamu", async () => {
  await api("put", `/me/favorites/${menuA1}`, customerToken).expect(204);
  const findMenuA1 = async () =>
    (await api("get", "/menus", customerToken).expect(200)).body.data.find((menu: any) => menu.id === menuA1)
      .is_favorite;
  expect(await findMenuA1()).toBe(true);
  const originalQuery = db.query.bind(db);
  const spy = vi
    .spyOn(db, "query")
    .mockImplementation(((sql: any, ...rest: any[]) =>
      String(sql).includes("auth_sessions")
        ? Promise.reject(new Error("putus"))
        : (originalQuery as any)(sql, ...rest)) as any);
  try {
    expect(await findMenuA1()).toBe(false);
    await api("get", "/me/favorites", customerToken).expect(500);
  } finally {
    spy.mockRestore();
  }
  await db.query("UPDATE auth_sessions SET expires_at = '2000-01-01 00:00:00'");
  expect(await findMenuA1()).toBe(false);
  await db.query("UPDATE auth_sessions SET expires_at = '2999-01-01 00:00:00'");
  expect(await findMenuA1()).toBe(true);
  await db.query("UPDATE users SET is_active = FALSE WHERE email = 'budi@mail.com'");
  expect(await findMenuA1()).toBe(false);
});

test("PUT: menu tersembunyi/id tidak valid 404, toko tutup 204", async () => {
  const inactiveMenu = await insertMenu(idA, { name: "Mati", is_active: false });
  const deletedMenu = await insertMenu(idA, { name: "Hapus", deleted_at: "2026-01-01 00:00:00" });
  await db.query("UPDATE merchants SET verification_status = 'suspended' WHERE id = ?", [idB]);
  for (const id of [inactiveMenu, deletedMenu, menuB1, "abc", "0", "99999"]) {
    const res = await api("put", `/me/favorites/${id}`, customerToken).expect(404);
    expect(res.body.error.message).toBe("Menu tidak ditemukan.");
  }
  await db.query("UPDATE merchants SET is_open = FALSE WHERE id = ?", [idA]);
  await api("put", `/me/favorites/${menuA1}`, customerToken).expect(204);
  expect(await countRows()).toBe(1);
});

test("hanya menu tampil, terbaru dulu, toko tutup & habis tetap ada, paginated", async () => {
  for (const [id, favoritedAt] of [
    [menuA1, "2026-01-01 00:00:00"],
    [menuA2, "2026-01-02 00:00:00"],
    [menuB1, "2026-01-03 00:00:00"],
  ]) {
    await api("put", `/me/favorites/${id}`, customerToken).expect(204);
    await db.query("UPDATE favorites SET created_at = ? WHERE menu_id = ?", [favoritedAt, id]);
  }
  expect(await favIds()).toEqual([menuB1, menuA2, menuA1]);
  await db.query("UPDATE menus SET is_active = FALSE WHERE id = ?", [menuA2]);
  const res = await api("get", "/me/favorites", customerToken).expect(200);
  expect(res.body.data.map((menu: any) => menu.id)).toEqual([menuB1, menuA1]);
  expect(res.body.meta.total).toBe(2);
  await db.query("UPDATE menus SET is_active = TRUE WHERE id = ?", [menuA2]);
  expect(await favIds()).toEqual([menuB1, menuA2, menuA1]);
  await db.query("UPDATE menus SET is_active = FALSE WHERE id = ?", [menuA2]);
  await db.query("UPDATE merchants SET is_open = FALSE WHERE id = ?", [idA]);
  await db.query("UPDATE menus SET quota_today = 5, sold_today = 5 WHERE id = ?", [menuA1]);
  const list = (await api("get", "/me/favorites", customerToken).expect(200)).body.data;
  expect(list.find((menu: any) => menu.id === menuA1)).toMatchObject({
    badge: "sold_out",
    merchant: { is_open: false },
  });
  const page2 = await api("get", "/me/favorites?limit=1&page=2", customerToken).expect(200);
  expect(page2.body.data.map((menu: any) => menu.id)).toEqual([menuA1]);
  expect(page2.body.meta).toEqual({ page: 2, limit: 1, total: 2 });
  await db.query("UPDATE merchants SET verification_status = 'suspended' WHERE id = ?", [idB]);
  expect(await favIds()).toEqual([menuA1]);
});

test("auth: tanpa token 401, penjual 403, favorit per pembeli", async () => {
  for (const [method, path] of [
    ["get", "/me/favorites"],
    ["put", `/me/favorites/${menuA1}`],
    ["delete", `/me/favorites/${menuA1}`],
  ] as const) {
    await api(method, path).expect(401);
    const res = await api(method, path, tokenA).expect(403);
    expect(res.body.error.message).toBe("Anda tidak memiliki akses.");
  }
  await request(app)
    .post("/api/v1/auth/customer/register")
    .send({ full_name: "Citra", email: "citra@mail.com", phone: "081233334444", password: "rahasia123" })
    .expect(201);
  const citraToken = await login("citra@mail.com");
  await api("put", `/me/favorites/${menuA1}`, citraToken).expect(204);
  expect(await favIds()).toEqual([]);
  expect(await favIds("", citraToken)).toEqual([menuA1]);
  await api("delete", `/me/favorites/${menuA1}`, customerToken).expect(204);
  expect(await favIds("", citraToken)).toEqual([menuA1]);
});
