import request from "supertest";
import { beforeAll, expect, test } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { migrate } from "../src/scripts/migrate";
import { resetTestDatabase } from "./helpers/db";

beforeAll(async () => {
  await migrate(await resetTestDatabase());
});

test("GET /api/v1/meta/merchant-types → 5 jenis usaha", async () => {
  const res = await request(app).get("/api/v1/meta/merchant-types");
  expect(res.status).toBe(200);
  expect(res.body.data).toHaveLength(5);
  expect(res.body.data[0]).toEqual({ id: 1, name: "Katering Nasi Box & Harian" });
});

test("jenis usaha nonaktif tidak ditampilkan", async () => {
  await db.query("UPDATE merchant_types SET is_active = FALSE WHERE id = 5");
  const res = await request(app).get("/api/v1/meta/merchant-types");
  expect(res.body.data.map((t: { id: number }) => t.id)).toEqual([1, 2, 3, 4]);
});

test("GET /api/v1/meta/categories → 7 kategori urut sort_order, nonaktif disembunyikan, urutan dari admin", async () => {
  let res = await request(app).get("/api/v1/meta/categories");
  expect(res.status).toBe(200);
  expect(res.body.data).toHaveLength(7);
  expect(res.body.data[0]).toEqual({ id: 1, name: "Nasi Box", slug: "nasi-box", icon: "bowl" });
  await db.query("UPDATE categories SET is_active = FALSE WHERE id = 7");
  res = await request(app).get("/api/v1/meta/categories");
  expect(res.body.data).toHaveLength(6);
  await db.query("UPDATE categories SET sort_order = 0 WHERE id = 5");
  res = await request(app).get("/api/v1/meta/categories");
  expect(res.body.data[0].id).toBe(5);
});

test("GET /api/v1/meta/pickup-points → urut nama, nonaktif disembunyikan", async () => {
  let res = await request(app).get("/api/v1/meta/pickup-points");
  expect(res.status).toBe(200);
  expect(res.body.data).toHaveLength(3);
  expect(Object.keys(res.body.data[0]).sort()).toEqual(["description", "id", "name"]);
  expect(res.body.data[0].name).toBe("Gazebo Fakultas Ilmu Komputer");
  await db.query("UPDATE pickup_points SET is_active = FALSE WHERE id = 2");
  res = await request(app).get("/api/v1/meta/pickup-points");
  expect(res.body.data.map((p: { id: number }) => p.id)).toEqual([3, 1]);
});

test("GET /api/v1/meta/settings → service_fee number, timezone string, mengikuti nilai admin", async () => {
  let res = await request(app).get("/api/v1/meta/settings");
  expect(res.status).toBe(200);
  expect(res.body.data).toEqual({ service_fee: 0, timezone: "Asia/Jakarta" });
  await db.query("UPDATE app_settings SET setting_value = '2000' WHERE setting_key = 'service_fee'");
  res = await request(app).get("/api/v1/meta/settings");
  expect(res.body.data.service_fee).toBe(2000);
});

test("rute meta/me yang tidak ada -> 404", async () => {
  expect((await request(app).get("/api/v1/meta/x")).status).toBe(404);
  expect((await request(app).get("/api/v1/me/password")).status).toBe(404);
});
