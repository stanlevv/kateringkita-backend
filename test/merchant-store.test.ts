import request from "supertest";
import { beforeEach, expect, test } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { migrate } from "../src/scripts/migrate";
import { createAdmin } from "../src/scripts/create-admin";
import { loginLimiter } from "../src/middleware/rateLimiter";
import { resetTestDatabase } from "./helpers/db";

let tA: string, tB: string, tCust: string, tAdmin: string;
let idA: number, idB: number;

const login = async (identifier: string) =>
  (await request(app).post("/api/v1/auth/login").send({ identifier, password: "rahasia123", client: "web" })).body.data.token as string;
const regMerchant = (name: string, phone: string, email: string) =>
  request(app).post("/api/v1/auth/merchant/register").send({
    full_name: name, email, phone, password: "rahasia123", business_name: `Dapur ${name}`, merchant_type_id: 1, address: "Jl. Mawar 1",
  }).expect(201);
const row = async (id: number) => ((await db.query<any[]>("SELECT * FROM merchants WHERE id=?", [id]))[0] as any[])[0];
const get = (u: string, t?: string) => { const r = request(app).get(`/api/v1/merchant${u}`); return t ? r.set("Authorization", `Bearer ${t}`) : r; };
const patch = (u: string, b: object, t: string) => request(app).patch(`/api/v1/merchant${u}`).set("Authorization", `Bearer ${t}`).send(b);

beforeEach(async () => {
  await migrate(await resetTestDatabase());
  loginLimiter.reset();
  await regMerchant("Siti", "081298765432", "siti@mail.com");
  await regMerchant("Andi", "081211112222", "andi@mail.com");
  await request(app).post("/api/v1/auth/customer/register").send({ full_name: "Budi", email: "budi@mail.com", phone: "081234567890", password: "rahasia123" }).expect(201);
  await createAdmin({ phone: "081300000009", fullName: "Admin Uji", password: "rahasia123" });
  tA = await login("siti@mail.com");
  tB = await login("andi@mail.com");
  tCust = await login("budi@mail.com");
  tAdmin = await login("081300000009");
  const [rows] = await db.query<any[]>("SELECT id FROM merchants ORDER BY id");
  idA = rows[0].id;
  idB = rows[1].id;
});

test("role: tanpa token 401, pembeli & admin 403", async () => {
  expect((await get("/profile")).status).toBe(401);
  expect((await get("/profile", tCust)).status).toBe(403);
  expect((await get("/profile", tAdmin)).status).toBe(403);
  expect((await patch("/status", { is_open: false }, tCust)).status).toBe(403);
  expect((await patch("/status", { is_open: false }, tAdmin)).status).toBe(403);
});

test("GET /merchant/profile: bentuk D3 milik penjual sendiri", async () => {
  const r = await get("/profile", tA).expect(200);
  expect(Object.keys(r.body.data).sort()).toEqual([
    "address", "business_name", "close_time", "daily_revenue_target", "description", "dine_in_enabled", "hold_minutes", "is_open", "logo_url",
    "merchant_type", "open_time", "pickup_point_ids", "service_mode", "wa_number", "wa_template",
  ]);
  expect(r.body.data).toMatchObject({
    business_name: "Dapur Siti", open_time: "07:00", close_time: "16:00", hold_minutes: 5, is_open: true,
    wa_template: null, pickup_point_ids: [], merchant_type: { id: 1, name: "Katering Nasi Box & Harian" },
  });
});

test("pickup_point_ids hanya titik aktif", async () => {
  await db.query("INSERT INTO merchant_pickup_points (merchant_id, pickup_point_id) VALUES (?, 1), (?, 2)", [idA, idA]);
  await db.query("UPDATE pickup_points SET is_active = FALSE WHERE id = 2");
  expect((await get("/profile", tA)).body.data.pickup_point_ids).toEqual([1]);
});

test("PATCH /merchant/status", async () => {
  const r = await patch("/status", { is_open: false }, tA).expect(200);
  expect(r.body).toEqual({ data: { is_open: false } });
  expect((await row(idA)).is_open).toBe(0);
  expect((await row(idB)).is_open).toBe(1);
  const bad = await patch("/status", { is_open: "no" }, tA).expect(400);
  expect(bad.body.error.fields.is_open).toBeDefined();
});

test("D9: toggle status tidak menggeser updated_at", async () => {
  await db.query("UPDATE merchants SET updated_at = '2026-01-01 00:00:00' WHERE id = ?", [idA]);
  await patch("/status", { is_open: false }, tA).expect(200);
  const [r] = await db.query<any[]>("SELECT DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s') u FROM merchants WHERE id = ?", [idA]);
  expect(r[0].u).toBe("2026-01-01 00:00:00");
});

test("path merchant tak dikenal → 404", async () => {
  expect((await get("/tidak-ada", tA)).status).toBe(404);
});
