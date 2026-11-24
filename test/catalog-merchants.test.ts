import request from "supertest";
import { beforeEach, expect, test } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { PRIVATE_KEYS, prepareMerchants, makeVisible } from "./helpers/merchant";

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
