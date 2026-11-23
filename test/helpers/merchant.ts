import { randomUUID } from "node:crypto";
import request from "supertest";
import { vi } from "vitest";
import app from "../../src/app";
import db from "../../src/config/db";
import { env } from "../../src/config/env";
import { migrate } from "../../src/scripts/migrate";
import { loginLimiter } from "../../src/middleware/rate-limiter";
import { getWibDate } from "../../src/services/merchant-quota.service";
import { clock } from "../../src/services/catalog.service";
import { resetTestDatabase } from "./db";

export const login = async (identifier: string) =>
  (await request(app).post("/api/v1/auth/login").send({ identifier, password: "rahasia123", client: "web" })).body.data
    .token as string;

// DB baru + penjual A (Siti), penjual B (Andi), pembeli Budi.
export async function prepareMerchants() {
  await migrate(await resetTestDatabase());
  loginLimiter.reset();
  for (const [name, phone, email] of [
    ["Siti", "081298765432", "siti@mail.com"],
    ["Andi", "081211112222", "andi@mail.com"],
  ]) {
    await request(app)
      .post("/api/v1/auth/merchant/register")
      .send({
        full_name: name,
        email,
        phone,
        password: "rahasia123",
        business_name: `Dapur ${name}`,
        merchant_type_id: 1,
        address: "Jl. Mawar 1",
      })
      .expect(201);
  }
  await request(app)
    .post("/api/v1/auth/customer/register")
    .send({ full_name: "Budi", email: "budi@mail.com", phone: "081234567890", password: "rahasia123" })
    .expect(201);
  const [rows] = await db.query<any[]>("SELECT id FROM merchants ORDER BY id");
  return {
    tokenA: await login("siti@mail.com"),
    tokenB: await login("andi@mail.com"),
    customerToken: await login("budi@mail.com"),
    idA: rows[0].id as number,
    idB: rows[1].id as number,
  };
}

// Sisipkan menu lewat SQL; stock_date hari ini kecuali ditimpa.
export async function insertMenu(merchantId: number, overrides: Record<string, unknown> = {}): Promise<number> {
  const row = {
    merchant_id: merchantId,
    category_id: 1,
    name: "Nasi Ayam",
    unit_label: "porsi",
    price: 15000,
    hpp: 9000,
    daily_quota: 20,
    quota_today: 20,
    sold_today: 0,
    held_today: 0,
    stock_date: getWibDate(),
    ...overrides,
  };
  const [result] = await db.query<any>("INSERT INTO menus SET ?", [row]);
  return result.insertId;
}

export const menuRow = async (id: number) =>
  ((await db.query<any[]>("SELECT * FROM menus WHERE id = ?", [id]))[0] as any[])[0];

// R2 palsu: env dibaca saat dipanggil, jadi test bisa mengisi/mengosongkan (D13)
export const TEST_R2_ENV = {
  R2_ACCOUNT_ID: "acc",
  R2_ACCESS_KEY_ID: "AKIDUJI",
  R2_SECRET_ACCESS_KEY: "rahasia-r2-uji-sangat-rahasia",
  R2_BUCKET: "bucket",
  R2_PUBLIC_URL: "https://foto.test",
};
export const setR2Env = (enabled = true) =>
  Object.assign(
    env,
    enabled ? TEST_R2_ENV : Object.fromEntries(Object.keys(TEST_R2_ENV).map((key) => [key, undefined])),
  );
export const photoUrl = (prefix: string, extension = "png") =>
  `${TEST_R2_ENV.R2_PUBLIC_URL}/${prefix}${randomUUID()}.${extension}`;

// "Sekarang" katalog dibekukan 10:00 WIB hari ini agar test tidak bergantung jam nyata (stok tetap tanggal hari ini)
export const freezeClock = () => vi.spyOn(clock, "now").mockReturnValue(Date.parse(`${getWibDate()}T10:00:00+07:00`));

// Toko lolos syarat tampil (verified, pemilik aktif) dan buka 07:00–16:00, atau tutup karena jam 11:00–12:00 (relatif ke freezeClock)
export async function makeVisible(merchantId: number, { open = true } = {}) {
  await db.query(
    "UPDATE merchants SET verification_status = 'verified', is_open = TRUE, open_time = ?, close_time = ? WHERE id = ?",
    [open ? "07:00:00" : "11:00:00", open ? "16:00:00" : "12:00:00", merchantId],
  );
}

// Kunci yang tidak boleh ada di respons publik (angka internal toko dan data pribadi)
export const PRIVATE_KEYS = [
  '"hpp"',
  '"margin"',
  '"sold_today"',
  '"quota_today"',
  '"held_today"',
  '"daily_quota"',
  '"sold_total"',
  '"wa_number"',
  '"address"',
];

// Pembeli ke-i (i ≥ 1) selain Budi; mengembalikan token
export async function createCustomer(i: number): Promise<string> {
  const email = `pembeli${i}@mail.com`;
  await request(app)
    .post("/api/v1/auth/customer/register")
    .send({ full_name: `Pembeli ${i}`, email, phone: `0813${String(i).padStart(8, "0")}`, password: "rahasia123" })
    .expect(201);
  return login(email);
}

// Data checkout: toko A tampil & buka (jam dibekukan 10:00 WIB), titik temu 1 dilayani A,
// menu Nasi Ayam 15000 (kuota 20, opsi Keju 3000 aktif + Basi nonaktif) dan Es Teh 5000
export async function prepareCheckout() {
  freezeClock();
  const merchants = await prepareMerchants();
  await makeVisible(merchants.idA);
  await db.query("INSERT INTO merchant_pickup_points (merchant_id, pickup_point_id) VALUES (?, 1)", [merchants.idA]);
  const menu = await insertMenu(merchants.idA);
  const menu2 = await insertMenu(merchants.idA, { name: "Es Teh", price: 5000, hpp: 2000 });
  const [cheeseOption] = await db.query<any>(
    "INSERT INTO menu_options (menu_id, name, extra_price, is_active) VALUES (?, 'Keju', 3000, TRUE)",
    [menu],
  );
  const [inactiveOption] = await db.query<any>(
    "INSERT INTO menu_options (menu_id, name, extra_price, is_active) VALUES (?, 'Basi', 0, FALSE)",
    [menu],
  );
  return { ...merchants, menu, menu2, keju: cheeseOption.insertId as number, basi: inactiveOption.insertId as number };
}

// Pesanan tunai lewat POST /orders (kunci idempotensi baru) → kode
export async function placeOrder(token: string, menuId: number, qty = 1): Promise<string> {
  const res = await request(app)
    .post("/api/v1/orders")
    .set("Authorization", `Bearer ${token}`)
    .set("Idempotency-Key", randomUUID())
    .send({ items: [{ menu_id: menuId, qty }], pickup_point_id: 1, payment_method: "cod" })
    .expect(201);
  return res.body.data.code;
}
