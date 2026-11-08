import { randomUUID } from "node:crypto";
import request from "supertest";
import { vi } from "vitest";
import app from "../../src/app";
import db from "../../src/config/db";
import { env } from "../../src/config/env";
import { migrate } from "../../src/scripts/migrate";
import { loginLimiter } from "../../src/middleware/rateLimiter";
import { hariIniWib } from "../../src/services/merchant-kuota.service";
import { jam } from "../../src/services/katalog.service";
import { resetTestDatabase } from "./db";

export const login = async (identifier: string) =>
  (await request(app).post("/api/v1/auth/login").send({ identifier, password: "rahasia123", client: "web" })).body.data.token as string;

// DB baru + penjual A (Siti), penjual B (Andi), pembeli Budi.
export async function siapkanToko() {
  await migrate(await resetTestDatabase());
  loginLimiter.reset();
  for (const [name, phone, email] of [["Siti", "081298765432", "siti@mail.com"], ["Andi", "081211112222", "andi@mail.com"]]) {
    await request(app).post("/api/v1/auth/merchant/register").send({
      full_name: name, email, phone, password: "rahasia123", business_name: `Dapur ${name}`, merchant_type_id: 1, address: "Jl. Mawar 1",
    }).expect(201);
  }
  await request(app).post("/api/v1/auth/customer/register")
    .send({ full_name: "Budi", email: "budi@mail.com", phone: "081234567890", password: "rahasia123" }).expect(201);
  const [rows] = await db.query<any[]>("SELECT id FROM merchants ORDER BY id");
  return {
    tA: await login("siti@mail.com"), tB: await login("andi@mail.com"), tCust: await login("budi@mail.com"),
    idA: rows[0].id as number, idB: rows[1].id as number,
  };
}

// Sisipkan menu lewat SQL; stock_date hari ini kecuali ditimpa.
export async function sisipMenu(merchantId: number, o: Record<string, unknown> = {}): Promise<number> {
  const row = {
    merchant_id: merchantId, category_id: 1, name: "Nasi Ayam", unit_label: "porsi", price: 15000, hpp: 9000,
    daily_quota: 20, quota_today: 20, sold_today: 0, held_today: 0, stock_date: hariIniWib(), ...o,
  };
  const [r] = await db.query<any>("INSERT INTO menus SET ?", [row]);
  return r.insertId;
}

export const menuRow = async (id: number) => ((await db.query<any[]>("SELECT * FROM menus WHERE id = ?", [id]))[0] as any[])[0];

// R2 palsu: env dibaca saat dipanggil, jadi test bisa mengisi/mengosongkan (D13)
export const R2_UJI = { R2_ACCOUNT_ID: "acc", R2_ACCESS_KEY_ID: "AKIDUJI", R2_SECRET_ACCESS_KEY: "rahasia-r2-uji-sangat-rahasia", R2_BUCKET: "bucket", R2_PUBLIC_URL: "https://foto.test" };
export const isiR2 = (on = true) => Object.assign(env, on ? R2_UJI : Object.fromEntries(Object.keys(R2_UJI).map((k) => [k, undefined])));
export const fotoUrl = (prefix: string, ext = "png") => `${R2_UJI.R2_PUBLIC_URL}/${prefix}${randomUUID()}.${ext}`;

// "Sekarang" katalog dibekukan 10:00 WIB hari ini agar test tidak bergantung jam nyata (stok tetap tanggal hari ini)
export const bekukanJam = () => vi.spyOn(jam, "sekarang").mockReturnValue(Date.parse(`${hariIniWib()}T10:00:00+07:00`));

// Toko lolos R-14 (verified) dan buka 07:00–16:00, atau tutup karena jam 11:00–12:00 (relatif ke bekukanJam)
export async function tampilkan(merchantId: number, { buka = true } = {}) {
  await db.query("UPDATE merchants SET verification_status = 'verified', is_open = TRUE, open_time = ?, close_time = ? WHERE id = ?",
    [buka ? "07:00:00" : "11:00:00", buka ? "16:00:00" : "12:00:00", merchantId]);
}

// Kunci yang tidak boleh ada di respons publik (R-11, BE-02)
export const BOCOR = ['"hpp"', '"margin"', '"sold_today"', '"quota_today"', '"held_today"', '"daily_quota"', '"sold_total"', '"wa_number"', '"address"'];

// Pembeli ke-i (i ≥ 1) selain Budi; mengembalikan token
export async function pembeliBaru(i: number): Promise<string> {
  const email = `pembeli${i}@mail.com`;
  await request(app).post("/api/v1/auth/customer/register")
    .send({ full_name: `Pembeli ${i}`, email, phone: `0813${String(i).padStart(8, "0")}`, password: "rahasia123" }).expect(201);
  return login(email);
}

// F06: toko A tampil & buka (jam dibekukan 10:00 WIB), titik temu 1 dilayani A,
// menu Nasi Ayam 15000 (kuota 20, opsi Keju 3000 aktif + Basi nonaktif) dan Es Teh 5000
export async function siapCheckout() {
  bekukanJam();
  const t = await siapkanToko();
  await tampilkan(t.idA);
  await db.query("INSERT INTO merchant_pickup_points (merchant_id, pickup_point_id) VALUES (?, 1)", [t.idA]);
  const menu = await sisipMenu(t.idA);
  const menu2 = await sisipMenu(t.idA, { name: "Es Teh", price: 5000, hpp: 2000 });
  const [k] = await db.query<any>("INSERT INTO menu_options (menu_id, name, extra_price, is_active) VALUES (?, 'Keju', 3000, TRUE)", [menu]);
  const [b] = await db.query<any>("INSERT INTO menu_options (menu_id, name, extra_price, is_active) VALUES (?, 'Basi', 0, FALSE)", [menu]);
  return { ...t, menu, menu2, keju: k.insertId as number, basi: b.insertId as number };
}

// F07: pesanan tunai lewat POST /orders (kunci idempotensi baru) → kode
export async function pesanDulu(token: string, menuId: number, qty = 1): Promise<string> {
  const r = await request(app).post("/api/v1/orders").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", randomUUID())
    .send({ items: [{ menu_id: menuId, qty }], pickup_point_id: 1, payment_method: "cod" }).expect(201);
  return r.body.data.code;
}
