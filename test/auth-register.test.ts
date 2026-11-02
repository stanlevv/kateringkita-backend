import bcrypt from "bcryptjs";
import request from "supertest";
import { RowDataPacket } from "mysql2";
import { beforeEach, expect, test } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { migrate } from "../src/db/migrate";
import { resetTestDatabase } from "./helpers/db";

beforeEach(async () => {
  await migrate(await resetTestDatabase());
});

const customer = { full_name: "Budi", email: " Budi@Mail.com ", phone: "081234567890", password: "rahasia123" };
const merchant = {
  full_name: "Siti",
  phone: "081111111111",
  password: "rahasia123",
  business_name: "Dapur Barokah",
  merchant_type_id: 1,
  address: "Kantin Vokasi",
};

test("registrasi customer → 201, email dinormalkan, password di-hash", async () => {
  const res = await request(app).post("/api/v1/auth/customer/register").send(customer);
  expect(res.status).toBe(201);
  expect(res.body.data.user.email).toBe("budi@mail.com");
  expect(res.body.data.user.role).toBe("customer");
  expect(res.body.data.user).not.toHaveProperty("password_hash");
  const [rows] = await db.query<RowDataPacket[]>("SELECT password_hash FROM users WHERE phone = ?", [customer.phone]);
  expect(rows[0].password_hash).not.toBe("rahasia123");
  expect(await bcrypt.compare("rahasia123", rows[0].password_hash)).toBe(true);
});

test("customer tanpa email → 400 fields.email", async () => {
  const { email: _email, ...body } = customer;
  const res = await request(app).post("/api/v1/auth/customer/register").send(body);
  expect(res.status).toBe(400);
  expect(res.body.error.fields.email).toBeDefined();
});

test("password tanpa angka → 400 fields.password", async () => {
  const res = await request(app).post("/api/v1/auth/customer/register").send({ ...customer, password: "abcdefgh" });
  expect(res.status).toBe(400);
  expect(res.body.error.fields.password).toBeDefined();
});

test("phone tidak diawali 08 → 400 fields.phone", async () => {
  const res = await request(app).post("/api/v1/auth/customer/register").send({ ...customer, phone: "0712345678" });
  expect(res.status).toBe(400);
  expect(res.body.error.fields.phone).toBeDefined();
});

test("phone sama dua kali → 409 CONFLICT", async () => {
  const first = await request(app).post("/api/v1/auth/customer/register").send(customer);
  expect(first.status).toBe(201);
  const second = await request(app).post("/api/v1/auth/customer/register").send({ ...customer, email: "lain@mail.com" });
  expect(second.status).toBe(409);
  expect(second.body.error.code).toBe("CONFLICT");
});

test("registrasi merchant tanpa email → 201 dengan slug dan wa_number", async () => {
  const res = await request(app).post("/api/v1/auth/merchant/register").send(merchant);
  expect(res.status).toBe(201);
  expect(res.body.data.merchant.slug).toMatch(/^dapur-barokah-[0-9a-f]{4}$/);
  expect(res.body.data.merchant.wa_number).toBe(merchant.phone);
  expect(res.body.data.user.role).toBe("merchant");
  expect(res.body.data.user.email).toBeNull();
  expect(res.body.data.user).not.toHaveProperty("password_hash");
});

test("merchant dengan email spasi → 201, email null", async () => {
  const res = await request(app).post("/api/v1/auth/merchant/register").send({ ...merchant, email: "  " });
  expect(res.status).toBe(201);
  expect(res.body.data.user.email).toBeNull();
});

test("password lebih dari 72 karakter → 400 fields.password", async () => {
  const res = await request(app).post("/api/v1/auth/customer/register").send({ ...customer, password: "a1".repeat(37) });
  expect(res.status).toBe(400);
  expect(res.body.error.fields.password).toBeDefined();
});

test("merchant_type_id tidak dikenal → 400 dan tidak ada user tersisa", async () => {
  const res = await request(app).post("/api/v1/auth/merchant/register").send({ ...merchant, merchant_type_id: 99 });
  expect(res.status).toBe(400);
  expect(res.body.error.fields.merchant_type_id).toBeDefined();
  const [rows] = await db.query<RowDataPacket[]>("SELECT id FROM users");
  expect(rows).toHaveLength(0);
});

test("email sama dua kali (customer) → 409 CONFLICT", async () => {
  await request(app).post("/api/v1/auth/customer/register").send(customer).expect(201);
  const res = await request(app)
    .post("/api/v1/auth/customer/register")
    .send({ ...customer, phone: "081200000000" });
  expect(res.status).toBe(409);
  expect(res.body.error.code).toBe("CONFLICT");
});

test("merchant dengan phone yang sudah dipakai → 409 dan tidak ada baris baru", async () => {
  await request(app).post("/api/v1/auth/merchant/register").send(merchant).expect(201);
  const res = await request(app)
    .post("/api/v1/auth/merchant/register")
    .send({ ...merchant, business_name: "Dapur Lain" });
  expect(res.status).toBe(409);
  const [users] = await db.query<RowDataPacket[]>("SELECT id FROM users");
  const [merchants] = await db.query<RowDataPacket[]>("SELECT id FROM merchants");
  expect(users).toHaveLength(1);
  expect(merchants).toHaveLength(1);
});
