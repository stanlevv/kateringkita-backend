import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { hariIniWib } from "../src/services/merchant-kuota.service";
import { kode } from "../src/services/pesanan.service";
import { menuRow, pembeliBaru, siapCheckout, tampilkan } from "./helpers/toko";

// F06 Task 3: POST /orders tunai + GET /orders/:code (C-09, C-11, R-02, R-05, R-06, D3–D9, D11, D12, D16)
let s: Awaited<ReturnType<typeof siapCheckout>>;

const KUNCI_ORDER = [
  "can_cancel", "can_complete", "can_review", "cancel_reason", "cancelled_by", "code", "created_at", "discount", "hold_until", "items", "merchant", "note", "payment",
  "payment_method", "payment_status", "pickup_at", "pickup_point", "seconds_left", "service_fee", "status", "subtotal", "total", "updated_at",
];
const pesan = (body: unknown, key: string | null = randomUUID(), token = s.tCust) => {
  const r = request(app).post("/api/v1/orders").set("Authorization", `Bearer ${token}`);
  return (key === null ? r : r.set("Idempotency-Key", key)).send(body as object);
};
const isi = (o: Record<string, unknown> = {}, item: Record<string, unknown> = {}) =>
  ({ items: [{ menu_id: s.menu, qty: 2, option_ids: [s.keju], ...item }], pickup_point_id: 1, payment_method: "cod", ...o });
const baca = (code: string, token = s.tCust) => request(app).get(`/api/v1/orders/${code}`).set("Authorization", `Bearer ${token}`);
const hitung = async (tabel: string) => Number(((await db.query<any[]>(`SELECT COUNT(*) n FROM ${tabel}`))[0] as any[])[0].n);

beforeEach(async () => {
  s = await siapCheckout();
});
afterEach(() => {
  vi.restoreAllMocks();
});

test("201: bentuk Order + payment tunai, kode KK-tanggal WIB, harga server, tanpa hpp", async () => {
  const r = await pesan(isi({ note: " Sambal dipisah ", total: 1 })).expect(201);
  const d = r.body.data;
  expect(Object.keys(d).sort()).toEqual(KUNCI_ORDER);
  expect(d.code).toMatch(new RegExp(`^KK-${hariIniWib().replaceAll("-", "")}-[0-9A-HJKMNP-TV-Z]{4}$`));
  expect(d).toMatchObject({
    status: "holding", payment_method: "cod", payment_status: "unpaid", payment: { method: "cod", status: "unpaid", amount: 36000 },
    merchant: { id: s.idA, business_name: "Dapur Siti", wa_number: "081298765432" },
    pickup_point: { id: 1, name: "Gedung Vokasi UB (Lt. 2)" }, note: "Sambal dipisah", pickup_at: null,
    subtotal: 36000, discount: 0, service_fee: 0, total: 36000,
    can_cancel: true, can_complete: false, can_review: false,
  });
  expect(d.items).toEqual([{
    menu_id: s.menu, menu_name: "Nasi Ayam", qty: 2, unit_price: 18000, options: [{ id: s.keju, name: "Keju", extra_price: 3000 }],
    line_total: 36000,
  }]);
  expect(d.seconds_left).toBeGreaterThanOrEqual(295);
  expect(d.seconds_left).toBeLessThanOrEqual(300);
  expect(JSON.stringify(r.body)).not.toContain('"hpp"');

  await db.query("UPDATE merchants SET hold_minutes = 10 WHERE id = ?", [s.idA]);
  const r2 = await pesan(isi()).expect(201);
  expect(r2.body.data.seconds_left).toBeGreaterThanOrEqual(595);
  expect(r2.body.data.seconds_left).toBeLessThanOrEqual(600);
});

test("DB: salinan pesanan, item, log status, held_today naik; nama dari body", async () => {
  const r = await pesan(isi()).expect(201);
  const [[o]] = await db.query<any[]>("SELECT * FROM orders WHERE code = ?", [r.body.data.code]);
  const [[budi]] = await db.query<any[]>("SELECT id FROM users WHERE full_name = 'Budi'");
  expect(o).toMatchObject({
    customer_id: budi.id, customer_name: "Budi", customer_phone: "081234567890", total: 36000, subtotal: 36000, payment_method: "cod",
    payment_status: "unpaid", status: "holding", merchant_id: s.idA, pickup_point_id: 1,
  });
  const [[sd]] = await db.query<any[]>("SELECT DATE_FORMAT(stock_date, '%Y-%m-%d') d FROM orders WHERE id = ?", [o.id]);
  expect(sd.d).toBe(hariIniWib());
  const [items] = await db.query<any[]>("SELECT menu_id, menu_name, unit_price, hpp, qty, options, line_total FROM order_items WHERE order_id = ?", [o.id]);
  expect(items).toEqual([{
    menu_id: s.menu, menu_name: "Nasi Ayam", unit_price: 18000, hpp: 9000, qty: 2, line_total: 36000,
    options: [{ id: s.keju, name: "Keju", extra_price: 3000 }],
  }]);
  const [logs] = await db.query<any[]>("SELECT from_status, to_status, actor_user_id FROM order_status_logs WHERE order_id = ?", [o.id]);
  expect(logs).toEqual([{ from_status: null, to_status: "holding", actor_user_id: budi.id }]);
  expect(await menuRow(s.menu)).toMatchObject({ held_today: 2, sold_today: 0 });

  const r2 = await pesan(isi({ customer_name: "Rina", customer_phone: "081111111111" })).expect(201);
  const [[o2]] = await db.query<any[]>("SELECT customer_name, customer_phone FROM orders WHERE code = ?", [r2.body.data.code]);
  expect(o2).toEqual({ customer_name: "Rina", customer_phone: "081111111111" });

  // kosong / spasi → nilai akun, sama dengan null
  const r3 = await pesan(isi({ customer_name: "  ", customer_phone: "" })).expect(201);
  const [[o3]] = await db.query<any[]>("SELECT customer_name, customer_phone FROM orders WHERE code = ?", [r3.body.data.code]);
  expect(o3).toEqual({ customer_name: "Budi", customer_phone: "081234567890" });
});

test("R-05: harga menu berubah setelah checkout → pesanan tetap harga lama", async () => {
  const r = await pesan(isi()).expect(201);
  await db.query("UPDATE menus SET price = 50000, name = 'Ganti' WHERE id = ?", [s.menu]);
  const g = await baca(r.body.data.code).expect(200);
  expect(g.body.data.items[0]).toMatchObject({ menu_name: "Nasi Ayam", unit_price: 18000, line_total: 36000 });
  expect(g.body.data.total).toBe(36000);
});

test("stok kemarin di-reset lewat segarkanKuota sebelum hold", async () => {
  await db.query("UPDATE menus SET stock_date = DATE_SUB(stock_date, INTERVAL 1 DAY), held_today = 7 WHERE id = ?", [s.menu]);
  await pesan(isi()).expect(201);
  const [[m]] = await db.query<any[]>("SELECT DATE_FORMAT(stock_date, '%Y-%m-%d') d, held_today FROM menus WHERE id = ?", [s.menu]);
  expect(m).toEqual({ d: hariIniWib(), held_today: 2 });
});

test("balapan tengah malam: menu sudah pindah ke tanggal stok lain → 409, hold tidak bocor ke hari lain", async () => {
  await db.query("UPDATE menus SET stock_date = DATE_ADD(stock_date, INTERVAL 1 DAY) WHERE id = ?", [s.menu]);
  const sebelum = await menuRow(s.menu);
  const r = await pesan(isi()).expect(409);
  expect(r.body.error.code).toBe("OUT_OF_STOCK");
  expect(await hitung("orders")).toBe(0);
  expect(await hitung("order_idempotency")).toBe(0);
  expect(await menuRow(s.menu)).toEqual(sebelum);
});

test("OUT_OF_STOCK: 409 dengan sisa per baris, tidak ada pesanan, held_today tetap", async () => {
  await db.query("UPDATE menus SET quota_today = 5, held_today = 4 WHERE id = ?", [s.menu]);
  const r = await pesan(isi()).expect(409);
  expect(r.body.error).toEqual({ code: "OUT_OF_STOCK", message: "Sisa porsi tidak cukup.", fields: { "items.0.qty": ["Sisa 1 porsi."] } });
  expect(await hitung("orders")).toBe(0);
  expect(await hitung("order_idempotency")).toBe(0);
  expect((await menuRow(s.menu)).held_today).toBe(4);
});

describe("validasi", () => {
  test("payment_method selain cod/va/online (termasuk qris, dihapus F26) / tidak ada → 400", async () => {
    for (const pm of ["transfer", "tunai", "qris", undefined]) {
      const r = await pesan(isi({ payment_method: pm })).expect(400);
      expect(r.body.error.fields.payment_method).toEqual(["Pilih bayar tunai, Virtual Account, atau bayar online."]);
    }
  });

  test("Idempotency-Key hilang / bukan UUID → 400", async () => {
    for (const k of [null, "abc"]) {
      const r = await pesan(isi(), k).expect(400);
      expect(r.body.error).toMatchObject({ code: "VALIDATION_ERROR", message: "Data tidak valid." });
      expect(r.body.error.fields).toEqual({ idempotency_key: ["Muat ulang aplikasi lalu coba lagi."] });
    }
  });

  test("promo → 422 tanpa pesanan", async () => {
    await pesan(isi({ promo_code: "HEMAT" })).expect(422);
    expect(await hitung("orders")).toBe(0);
  });

  test("R-14 / tutup lewat POST /orders → 409, tanpa baris tertinggal", async () => {
    await db.query("UPDATE merchants SET verification_status = 'suspended' WHERE id = ?", [s.idA]);
    expect((await pesan(isi()).expect(409)).body.error.code).toBe("MERCHANT_UNAVAILABLE");
    await tampilkan(s.idA, { buka: false });
    expect((await pesan(isi()).expect(409)).body.error.code).toBe("MERCHANT_CLOSED");
    expect(await hitung("orders")).toBe(0);
    expect(await hitung("order_idempotency")).toBe(0);
  });
});

test("D11: 3 pesanan menunggu → ke-4 409; satu kadaluarsa → lolos", async () => {
  for (let i = 0; i < 3; i++) await pesan(isi({}, { qty: 1 })).expect(201);
  const k = randomUUID();
  const r = await pesan(isi({}, { qty: 1 }), k).expect(409);
  expect(r.body.error).toMatchObject({ code: "CONFLICT", message: "Masih ada 3 pesanan yang menunggu. Selesaikan atau batalkan dulu." });
  await db.query("UPDATE orders SET hold_until = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE) ORDER BY id LIMIT 1");
  await pesan(isi({}, { qty: 1 }), k).expect(201);
});

test("D7: kode bentrok → buat ulang; selalu bentrok → 500 tanpa sisa", async () => {
  const hari = hariIniWib().replaceAll("-", "");
  vi.spyOn(kode, "acak").mockReturnValueOnce("AAAA").mockReturnValueOnce("AAAA").mockReturnValueOnce("BBBB");
  expect((await pesan(isi({}, { qty: 1 })).expect(201)).body.data.code).toBe(`KK-${hari}-AAAA`);
  expect((await pesan(isi({}, { qty: 1 })).expect(201)).body.data.code).toBe(`KK-${hari}-BBBB`);
  vi.spyOn(kode, "acak").mockReturnValue("AAAA");
  const k = randomUUID();
  const r = await pesan(isi({}, { qty: 1 }), k).expect(500);
  expect(r.body.error.code).toBe("INTERNAL_ERROR");
  expect(await hitung("orders")).toBe(2);
  const [rows] = await db.query<any[]>("SELECT 1 FROM order_idempotency WHERE idem_key = ?", [k]);
  expect(rows).toHaveLength(0);
  expect((await menuRow(s.menu)).held_today).toBe(2);
});

test("pickup_at ikut di Order (ISO UTC)", async () => {
  const r = await pesan(isi({ pickup_at: `${hariIniWib()}T13:30:00+07:00` })).expect(201);
  expect(r.body.data.pickup_at).toBe(new Date(`${hariIniWib()}T13:30:00+07:00`).toISOString());
});

// Injeksi galat memakai CREATE TRIGGER; TiDB tidak punya trigger, jadi blok ini hanya jalan di MySQL
describe.skipIf(process.env.DATABASE_URL?.includes("tidbcloud.com"))("galat di tengah transaksi (D6, D7)", () => {
  afterEach(async () => {
    await db.query("DROP TRIGGER IF EXISTS uji_gagal");
  });

  test("galat setelah klaim → 500, klaim di-rollback, kunci sama boleh diulang", async () => {
    await db.query(`CREATE TRIGGER uji_gagal BEFORE INSERT ON order_items FOR EACH ROW
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'gagal uji'`);
    const k = randomUUID();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await pesan(isi(), k).expect(500);
    expect(await hitung("orders")).toBe(0);
    expect(await hitung("order_idempotency")).toBe(0);
    expect((await menuRow(s.menu)).held_today).toBe(0);
    await db.query("DROP TRIGGER uji_gagal");
    await pesan(isi(), k).expect(201);
  });

  test("duplikat pada kunci selain orders.code bukan tabrakan kode → tidak dicoba ulang", async () => {
    await db.query(`CREATE TRIGGER uji_gagal BEFORE INSERT ON orders FOR EACH ROW
      SIGNAL SQLSTATE '23000' SET MESSAGE_TEXT = "Duplicate entry 'x' for key 'orders.lain'", MYSQL_ERRNO = 1062`);
    const acak = vi.spyOn(kode, "acak");
    const r = await pesan(isi());
    expect(r.status).not.toBe(201);
    expect(acak).toHaveBeenCalledTimes(1);
    expect(await hitung("order_idempotency")).toBe(0);
  });
});

describe("GET /orders/:code", () => {
  test("pemilik 200 bentuk sama; pembeli lain / kode tak ada 404; penjual 403; tanpa token 401", async () => {
    const r = await pesan(isi()).expect(201);
    const code = r.body.data.code;
    const g = await baca(code).expect(200);
    expect(Object.keys(g.body.data).sort()).toEqual(KUNCI_ORDER);
    expect({ ...g.body.data, seconds_left: 0 }).toEqual({ ...r.body.data, seconds_left: 0 });
    const lain = await pembeliBaru(1);
    const x = await baca(code, lain).expect(404);
    expect(x.body.error).toMatchObject({ code: "NOT_FOUND", message: "Pesanan tidak ditemukan." });
    await baca("KK-00000000-ZZZZ").expect(404);
    await baca(code, s.tA).expect(403);
    await request(app).get(`/api/v1/orders/${code}`).expect(401);
  });
});
