import request from "supertest";
import { beforeEach, expect, test } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { PRIVATE_KEYS, prepareMerchants, makeVisible, insertMenu } from "./helpers/merchant";

let idA: number, idB: number;

const list = () => request(app).get("/api/v1/merchants");
const slugs = (body: any) => body.data.map((m: any) => m.slug);
const slugOf = async (id: number) =>
  ((await db.query<any[]>("SELECT slug FROM merchants WHERE id = ?", [id]))[0] as any[])[0].slug as string;

beforeEach(async () => {
  ({ idA, idB } = await prepareMerchants());
});

test("toko terverifikasi muncul, urut nama", async () => {
  await makeVisible(idA);
  await makeVisible(idB);
  const res = await list().expect(200);
  // "Dapur Andi" (B) mendahului "Dapur Siti" (A)
  expect(slugs(res.body)).toEqual([await slugOf(idB), await slugOf(idA)]);
});

test("kunci respons persis", async () => {
  await makeVisible(idA);
  const res = await list().expect(200);
  expect(Object.keys(res.body.data[0]).sort()).toEqual([
    "business_name",
    "logo_url",
    "menu_count",
    "merchant_type",
    "rating_avg",
    "rating_count",
    "slug",
  ]);
  expect(typeof res.body.data[0].rating_avg).toBe("number");
  for (const key of PRIVATE_KEYS) expect(res.text).not.toContain(key);
});

test("toko pending/suspended dan pemilik nonaktif tidak muncul", async () => {
  await makeVisible(idA);
  await makeVisible(idB);
  await db.query("UPDATE merchants SET verification_status = 'pending' WHERE id = ?", [idA]);
  await db.query("UPDATE users SET is_active = 0 WHERE id = (SELECT user_id FROM merchants WHERE id = ?)", [idB]);
  const res = await list().expect(200);
  expect(res.body.data).toEqual([]);
});

test("toko tutup tetap muncul", async () => {
  await makeVisible(idA, { open: false });
  await db.query("UPDATE merchants SET is_open = 0 WHERE id = ?", [idA]);
  const res = await list().expect(200);
  expect(slugs(res.body)).toEqual([await slugOf(idA)]);
});

test("tanpa token tetap 200", async () => {
  await list().expect(200);
});

test("menu_count menghitung menu aktif termasuk yang habis, bukan yang nonaktif", async () => {
  await makeVisible(idA);
  await makeVisible(idB);
  await insertMenu(idA);
  await insertMenu(idA, { name: "Habis", quota_today: 0 });
  await insertMenu(idA, { name: "Nonaktif", is_active: false });
  const res = await list().expect(200);
  expect(res.body.data.map((m: any) => [m.slug, m.menu_count])).toEqual([
    [await slugOf(idB), 0],
    [await slugOf(idA), 2],
  ]);
});

test("filter pickup_point_id: hanya toko yang melayani titik aktif itu, toko tutup ikut", async () => {
  await makeVisible(idA, { open: false });
  await makeVisible(idB);
  await db.query("INSERT INTO merchant_pickup_points (merchant_id, pickup_point_id) VALUES (?, 1)", [idA]);
  const res = await request(app).get("/api/v1/merchants?pickup_point_id=1").expect(200);
  expect(slugs(res.body)).toEqual([await slugOf(idA)]);
  await db.query("UPDATE pickup_points SET is_active = 0 WHERE id = 1");
  expect((await request(app).get("/api/v1/merchants?pickup_point_id=1").expect(200)).body.data).toEqual([]);
  expect((await request(app).get("/api/v1/merchants?pickup_point_id=999999").expect(200)).body.data).toEqual([]);
});

test.each(["abc", "0", "-1"])("pickup_point_id=%s ditolak 400", async (value) => {
  const res = await request(app).get(`/api/v1/merchants?pickup_point_id=${value}`).expect(400);
  expect(res.body.error.fields.pickup_point_id).toEqual(["Titik temu tidak valid."]);
});
