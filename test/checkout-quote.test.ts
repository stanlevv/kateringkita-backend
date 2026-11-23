import request from "supertest";
import { beforeEach, describe, expect, test } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { getWibDate } from "../src/services/merchant-quota.service";
import { menuRow, prepareCheckout, insertMenu, makeVisible } from "./helpers/merchant";

// F06 Task 2: POST /orders/quote (C-09, R-07, R-13, R-14, D1–D3, D10, D13)
let setup: Awaited<ReturnType<typeof prepareCheckout>>;

const quote = (body: unknown, token = setup.customerToken) =>
  request(app)
    .post("/api/v1/orders/quote")
    .set("Authorization", `Bearer ${token}`)
    .send(body as object);
const satu = (overrides: Record<string, unknown> = {}, item: Record<string, unknown> = {}) => ({
  items: [{ menu_id: setup.menu, qty: 1, ...item }],
  pickup_point_id: 1,
  ...overrides,
});
const tolak400 = async (body: unknown, field: string, pesan: string) => {
  const res = await quote(body).expect(400);
  expect(res.body.error).toMatchObject({ code: "VALIDATION_ERROR", message: "Data tidak valid." });
  expect(res.body.error.fields[field]).toEqual([pesan]);
};
const tolak409 = async (body: unknown, code: string, pesan: string) => {
  const res = await quote(body).expect(409);
  expect(res.body.error).toMatchObject({ code, message: pesan });
};
// Waktu WIB d hari dari "sekarang" yang dibekukan (10:00 WIB hari ini)
const wib = (dayOffset: number, jam = "10:00") =>
  `${getWibDate(new Date(Date.parse(`${getWibDate()}T10:00:00+07:00`) + dayOffset * 86400e3))}T${jam}:00+07:00`;

beforeEach(async () => {
  setup = await prepareCheckout();
});

test("harga dihitung server: opsi + biaya layanan, field harga client diabaikan, tanpa angka internal", async () => {
  await db.query("UPDATE app_settings SET setting_value = '2000' WHERE setting_key = 'service_fee'");
  const res = await quote({
    items: [{ menu_id: setup.menu, qty: 2, option_ids: [setup.keju], unit_price: 1, total: 1 }],
    pickup_point_id: 1,
    total: 1,
    subtotal: 1,
  }).expect(200);
  expect(res.body.data).toEqual({
    items: [
      {
        menu_id: setup.menu,
        menu_name: "Nasi Ayam",
        qty: 2,
        unit_price: 18000,
        options: [{ id: setup.keju, name: "Keju", extra_price: 3000 }],
        line_total: 36000,
        available: 20,
      },
    ],
    subtotal: 36000,
    discount: 0,
    merchant_discount: 0,
    platform_discount: 0,
    service_fee: 2000,
    total: 38000,
    vouchers_applied: [],
    warnings: [],
  });
  const json = JSON.stringify(res.body);
  for (const key of ['"hpp"', '"sold_today"', '"held_today"', '"quota_today"']) expect(json).not.toContain(key);
});

test("biaya layanan bukan angka → 0", async () => {
  await db.query("UPDATE app_settings SET setting_value = 'abc' WHERE setting_key = 'service_fee'");
  const res = await quote(satu()).expect(200);
  expect(res.body.data).toMatchObject({ subtotal: 15000, service_fee: 0, total: 15000 });
});

test("menu sama dua baris (opsi berbeda) → dua item, stok dijumlah", async () => {
  await db.query("UPDATE menus SET quota_today = 5, held_today = 4 WHERE id = ?", [setup.menu]);
  const res = await quote({
    items: [
      { menu_id: setup.menu, qty: 1, option_ids: [setup.keju] },
      { menu_id: setup.menu, qty: 1 },
    ],
    pickup_point_id: 1,
  }).expect(200);
  expect(res.body.data.items.map((i: any) => i.unit_price)).toEqual([18000, 15000]);
  expect(res.body.data.subtotal).toBe(33000);
  expect(res.body.data.warnings).toEqual([
    { code: "OUT_OF_STOCK", menu_id: setup.menu, available: 1, message: "Sisa Nasi Ayam tinggal 1 porsi." },
  ]);
});

test("stok kurang → 200 dengan warnings; stock_date lama → kuota harian, DB tidak ditulis", async () => {
  await db.query("UPDATE menus SET quota_today = 5, held_today = 4 WHERE id = ?", [setup.menu]);
  const res = await quote(satu({}, { qty: 3 })).expect(200);
  expect(res.body.data.warnings).toEqual([
    { code: "OUT_OF_STOCK", menu_id: setup.menu, available: 1, message: "Sisa Nasi Ayam tinggal 1 porsi." },
  ]);
  expect(res.body.data.items[0].available).toBe(1);

  await db.query("UPDATE menus SET stock_date = '2000-01-01', daily_quota = 8 WHERE id = ?", [setup.menu]);
  const sebelum = await menuRow(setup.menu);
  const res2 = await quote(satu()).expect(200);
  expect(res2.body.data.items[0].available).toBe(8);
  expect(await menuRow(setup.menu)).toEqual(sebelum);
});

describe("validasi body (zod)", () => {
  test("items kosong / qty / opsi / titik temu / catatan / nama / HP / waktu", async () => {
    await tolak400({ items: [], pickup_point_id: 1 }, "items", "Pilih 1–20 menu.");
    await tolak400({ pickup_point_id: 1 }, "items", "Pilih 1–20 menu.");
    await tolak400(satu({}, { qty: 0 }), "items.0.qty", "Jumlah harus 1–1000.");
    await tolak400(satu({}, { qty: "2" }), "items.0.qty", "Jumlah harus 1–1000.");
    await tolak400(satu({}, { option_ids: ["x"] }), "items.0.option_ids", "Pilihan tidak valid.");
    await tolak400(satu({ pickup_point_id: null }), "pickup_point_id", "Pilih titik temu.");
    await tolak400(satu({ note: "x".repeat(256) }), "note", "Catatan maksimal 255 karakter.");
    await tolak400(satu({ customer_name: "x".repeat(151) }), "customer_name", "Nama 1–150 karakter.");
    await tolak400(
      satu({ customer_phone: "0812" }),
      "customer_phone",
      "Nomor HP harus diawali 08 dan berisi 10–13 angka.",
    );
    await tolak400(satu({ pickup_at: "besok" }), "pickup_at", "Waktu ambil tidak valid.");
  });
});

test("body bukan objek / kosong → pesan Indonesia", async () => {
  // primitif JSON sudah ditolak express.json (strict) dengan "Format JSON tidak valid."
  for (const body of [undefined, "[1,2]"]) {
    const req = request(app).post("/api/v1/orders/quote").set("Authorization", `Bearer ${setup.customerToken}`);
    const res = await (body === undefined ? req : req.set("Content-Type", "application/json").send(body)).expect(400);
    expect(res.body.error).toEqual({
      code: "VALIDATION_ERROR",
      message: "Data tidak valid.",
      fields: { "": ["Data pesanan tidak valid."] },
    });
  }
});

test("total melewati batas angka → 400 items", async () => {
  await db.query("UPDATE menus SET price = 3000000, hpp = 0 WHERE id = ?", [setup.menu]);
  await tolak400(satu({}, { qty: 1000 }), "items", "Total pesanan terlalu besar. Kurangi jumlah pesanan.");
  await db.query("UPDATE menus SET price = 2000000 WHERE id = ?", [setup.menu]);
  await quote(satu({}, { qty: 1000 })).expect(200);
});

describe("urutan validasi D3", () => {
  test("menu nonaktif / terhapus / tidak ada → items.0.menu_id", async () => {
    const mati = await insertMenu(setup.idA, { is_active: false });
    const hapus = await insertMenu(setup.idA, { deleted_at: new Date() });
    for (const id of [mati, hapus, 99999])
      await tolak400(satu({}, { menu_id: id }), "items.0.menu_id", "Menu tidak tersedia.");
  });

  test("menu dari dua toko → items", async () => {
    await makeVisible(setup.idB);
    const menuB = await insertMenu(setup.idB);
    await tolak400(
      {
        items: [
          { menu_id: setup.menu, qty: 1 },
          { menu_id: menuB, qty: 1 },
        ],
        pickup_point_id: 1,
      },
      "items",
      "Semua menu harus dari satu toko.",
    );
  });

  test("R-14: toko pending / suspended / pemilik nonaktif → MERCHANT_UNAVAILABLE", async () => {
    for (const status of ["pending", "suspended"]) {
      await db.query("UPDATE merchants SET verification_status = ? WHERE id = ?", [status, setup.idA]);
      await tolak409(satu(), "MERCHANT_UNAVAILABLE", "Toko ini sedang tidak menerima pesanan.");
    }
    await makeVisible(setup.idA);
    await db.query("UPDATE users SET is_active = FALSE WHERE id = (SELECT user_id FROM merchants WHERE id = ?)", [
      setup.idA,
    ]);
    await tolak409(satu(), "MERCHANT_UNAVAILABLE", "Toko ini sedang tidak menerima pesanan.");
  });

  test("R-13: saklar mati / di luar jam → MERCHANT_CLOSED dengan jam buka", async () => {
    await db.query("UPDATE merchants SET is_open = FALSE WHERE id = ?", [setup.idA]);
    await tolak409(satu(), "MERCHANT_CLOSED", "Toko sedang tutup. Buka pukul 07.00–16.00 WIB.");
    await makeVisible(setup.idA, { open: false });
    await tolak409(satu(), "MERCHANT_CLOSED", "Toko sedang tutup. Buka pukul 11.00–12.00 WIB.");
    // dua galat sekaligus: toko tutup menang atas titik temu salah
    await tolak409(satu({ pickup_point_id: 2 }), "MERCHANT_CLOSED", "Toko sedang tutup. Buka pukul 11.00–12.00 WIB.");
  });

  test("titik temu tidak dilayani / nonaktif → pickup_point_id", async () => {
    await tolak400(satu({ pickup_point_id: 2 }), "pickup_point_id", "Titik temu tidak dilayani toko ini.");
    await db.query("UPDATE pickup_points SET is_active = FALSE WHERE id = 1");
    await tolak400(satu(), "pickup_point_id", "Titik temu tidak dilayani toko ini.");
  });

  test("qty di bawah minimum → items.0.qty", async () => {
    await db.query("UPDATE menus SET min_order_qty = 3 WHERE id = ?", [setup.menu]);
    await tolak400(satu({}, { qty: 2 }), "items.0.qty", "Minimal pesan 3 porsi.");
  });

  test("opsi nonaktif / milik menu lain → items.0.option_ids", async () => {
    const [result] = await db.query<any>(
      "INSERT INTO menu_options (menu_id, name, extra_price) VALUES (?, 'Gula', 0)",
      [setup.menu2],
    );
    for (const id of [setup.basi, result.insertId]) {
      await tolak400(satu({}, { option_ids: [id] }), "items.0.option_ids", "Pilihan tidak tersedia.");
    }
  });

  test("promo tak dikenal → 422 PROMO_INVALID; promo kosong diabaikan", async () => {
    const res = await quote(satu({ promo_code: "HEMAT" })).expect(422);
    expect(res.body.error).toMatchObject({ code: "PROMO_INVALID", message: "Kode promo tidak ditemukan." });
    await quote(satu({ promo_code: "  " })).expect(200);
  });
});

describe("pickup_at (D13)", () => {
  const RENTANG = "Waktu ambil harus di masa depan, paling lambat 7 hari lagi.";
  test("kemarin / +8 hari → 400; besok → 200", async () => {
    await tolak400(satu({ pickup_at: wib(-1) }), "pickup_at", RENTANG);
    await tolak400(satu({ pickup_at: wib(8) }), "pickup_at", RENTANG);
    await quote(satu({ pickup_at: wib(1) })).expect(200);
  });

  test("pre-order H-2: tanpa waktu / besok → 400; lusa → 200", async () => {
    await db.query("UPDATE menus SET is_preorder = TRUE, preorder_days = 2 WHERE id = ?", [setup.menu]);
    const PREORDER_MSG = "Menu pre-order harus diambil paling cepat H-2.";
    await tolak400(satu(), "pickup_at", PREORDER_MSG);
    await tolak400(satu({ pickup_at: wib(1, "15:00") }), "pickup_at", PREORDER_MSG);
    await quote(satu({ pickup_at: wib(2) })).expect(200);
  });
});

test("auth: tanpa token 401, penjual 403", async () => {
  await request(app).post("/api/v1/orders/quote").send(satu()).expect(401);
  await quote(satu(), setup.tokenA).expect(403);
});
