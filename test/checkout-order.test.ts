import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { getWibDate } from "../src/services/merchant-quota.service";
import { codeGenerator } from "../src/services/order.service";
import { menuRow, createCustomer, prepareCheckout, makeVisible } from "./helpers/merchant";

// F06 Task 3: POST /orders tunai + GET /orders/:code (C-09, C-11, R-02, R-05, R-06, D3–D9, D11, D12, D16)
let setup: Awaited<ReturnType<typeof prepareCheckout>>;

const KUNCI_ORDER = [
  "can_cancel",
  "can_complete",
  "can_review",
  "cancel_reason",
  "cancelled_by",
  "code",
  "created_at",
  "discount",
  "hold_until",
  "items",
  "merchant",
  "note",
  "payment",
  "payment_method",
  "payment_status",
  "pickup_at",
  "pickup_point",
  "seconds_left",
  "service_fee",
  "status",
  "subtotal",
  "total",
  "updated_at",
];
const pesan = (body: unknown, key: string | null = randomUUID(), token = setup.customerToken) => {
  const req = request(app).post("/api/v1/orders").set("Authorization", `Bearer ${token}`);
  return (key === null ? req : req.set("Idempotency-Key", key)).send(body as object);
};
const isi = (overrides: Record<string, unknown> = {}, item: Record<string, unknown> = {}) => ({
  items: [{ menu_id: setup.menu, qty: 2, option_ids: [setup.keju], ...item }],
  pickup_point_id: 1,
  payment_method: "cod",
  ...overrides,
});
const baca = (code: string, token = setup.customerToken) =>
  request(app).get(`/api/v1/orders/${code}`).set("Authorization", `Bearer ${token}`);
const hitung = async (tabel: string) =>
  Number(((await db.query<any[]>(`SELECT COUNT(*) n FROM ${tabel}`))[0] as any[])[0].n);

beforeEach(async () => {
  setup = await prepareCheckout();
});
afterEach(() => {
  vi.restoreAllMocks();
});

test("201: bentuk Order + payment tunai, kode KK-tanggal WIB, harga server, tanpa hpp", async () => {
  const res = await pesan(isi({ note: " Sambal dipisah ", total: 1 })).expect(201);
  const data = res.body.data;
  expect(Object.keys(data).sort()).toEqual(KUNCI_ORDER);
  expect(data.code).toMatch(new RegExp(`^KK-${getWibDate().replace(/-/g, "")}-[0-9A-HJKMNP-TV-Z]{4}$`));
  expect(data).toMatchObject({
    status: "holding",
    payment_method: "cod",
    payment_status: "unpaid",
    payment: { method: "cod", status: "unpaid", amount: 36000 },
    merchant: { id: setup.idA, business_name: "Dapur Siti", wa_number: "081298765432" },
    pickup_point: { id: 1, name: "Gedung Vokasi UB (Lt. 2)" },
    note: "Sambal dipisah",
    pickup_at: null,
    subtotal: 36000,
    discount: 0,
    service_fee: 0,
    total: 36000,
    can_cancel: true,
    can_complete: false,
    can_review: false,
  });
  expect(data.items).toEqual([
    {
      menu_id: setup.menu,
      menu_name: "Nasi Ayam",
      qty: 2,
      unit_price: 18000,
      options: [{ id: setup.keju, name: "Keju", extra_price: 3000 }],
      line_total: 36000,
    },
  ]);
  expect(data.seconds_left).toBeGreaterThanOrEqual(295);
  expect(data.seconds_left).toBeLessThanOrEqual(300);
  expect(JSON.stringify(res.body)).not.toContain('"hpp"');

  await db.query("UPDATE merchants SET hold_minutes = 10 WHERE id = ?", [setup.idA]);
  const res2 = await pesan(isi()).expect(201);
  expect(res2.body.data.seconds_left).toBeGreaterThanOrEqual(595);
  expect(res2.body.data.seconds_left).toBeLessThanOrEqual(600);
});

test("DB: salinan pesanan, item, log status, held_today naik; nama dari body", async () => {
  const res = await pesan(isi()).expect(201);
  const [[order]] = await db.query<any[]>("SELECT * FROM orders WHERE code = ?", [res.body.data.code]);
  const [[budi]] = await db.query<any[]>("SELECT id FROM users WHERE full_name = 'Budi'");
  expect(order).toMatchObject({
    customer_id: budi.id,
    customer_name: "Budi",
    customer_phone: "081234567890",
    total: 36000,
    subtotal: 36000,
    payment_method: "cod",
    payment_status: "unpaid",
    status: "holding",
    merchant_id: setup.idA,
    pickup_point_id: 1,
  });
  const [[stockDate]] = await db.query<any[]>("SELECT DATE_FORMAT(stock_date, '%Y-%m-%d') d FROM orders WHERE id = ?", [
    order.id,
  ]);
  expect(stockDate.d).toBe(getWibDate());
  const [items] = await db.query<any[]>(
    "SELECT menu_id, menu_name, unit_price, hpp, qty, options, line_total FROM order_items WHERE order_id = ?",
    [order.id],
  );
  expect(items).toEqual([
    {
      menu_id: setup.menu,
      menu_name: "Nasi Ayam",
      unit_price: 18000,
      hpp: 9000,
      qty: 2,
      line_total: 36000,
      options: [{ id: setup.keju, name: "Keju", extra_price: 3000 }],
    },
  ]);
  const [logs] = await db.query<any[]>(
    "SELECT from_status, to_status, actor_user_id FROM order_status_logs WHERE order_id = ?",
    [order.id],
  );
  expect(logs).toEqual([{ from_status: null, to_status: "holding", actor_user_id: budi.id }]);
  expect(await menuRow(setup.menu)).toMatchObject({ held_today: 2, sold_today: 0 });

  const res2 = await pesan(isi({ customer_name: "Rina", customer_phone: "081111111111" })).expect(201);
  const [[order2]] = await db.query<any[]>("SELECT customer_name, customer_phone FROM orders WHERE code = ?", [
    res2.body.data.code,
  ]);
  expect(order2).toEqual({ customer_name: "Rina", customer_phone: "081111111111" });

  // kosong / spasi → nilai akun, sama dengan null
  const res3 = await pesan(isi({ customer_name: "  ", customer_phone: "" })).expect(201);
  const [[order3]] = await db.query<any[]>("SELECT customer_name, customer_phone FROM orders WHERE code = ?", [
    res3.body.data.code,
  ]);
  expect(order3).toEqual({ customer_name: "Budi", customer_phone: "081234567890" });
});

test("R-05: harga menu berubah setelah checkout → pesanan tetap harga lama", async () => {
  const res = await pesan(isi()).expect(201);
  await db.query("UPDATE menus SET price = 50000, name = 'Ganti' WHERE id = ?", [setup.menu]);
  const detailRes = await baca(res.body.data.code).expect(200);
  expect(detailRes.body.data.items[0]).toMatchObject({ menu_name: "Nasi Ayam", unit_price: 18000, line_total: 36000 });
  expect(detailRes.body.data.total).toBe(36000);
});

test("stok kemarin di-reset lewat refreshDailyQuota sebelum hold", async () => {
  await db.query("UPDATE menus SET stock_date = DATE_SUB(stock_date, INTERVAL 1 DAY), held_today = 7 WHERE id = ?", [
    setup.menu,
  ]);
  await pesan(isi()).expect(201);
  const [[menu]] = await db.query<any[]>(
    "SELECT DATE_FORMAT(stock_date, '%Y-%m-%d') d, held_today FROM menus WHERE id = ?",
    [setup.menu],
  );
  expect(menu).toEqual({ d: getWibDate(), held_today: 2 });
});

test("balapan tengah malam: menu sudah pindah ke tanggal stok lain → 409, hold tidak bocor ke hari lain", async () => {
  await db.query("UPDATE menus SET stock_date = DATE_ADD(stock_date, INTERVAL 1 DAY) WHERE id = ?", [setup.menu]);
  const sebelum = await menuRow(setup.menu);
  const res = await pesan(isi()).expect(409);
  expect(res.body.error.code).toBe("OUT_OF_STOCK");
  expect(await hitung("orders")).toBe(0);
  expect(await hitung("order_idempotency")).toBe(0);
  expect(await menuRow(setup.menu)).toEqual(sebelum);
});

test("OUT_OF_STOCK: 409 dengan sisa per baris, tidak ada pesanan, held_today tetap", async () => {
  await db.query("UPDATE menus SET quota_today = 5, held_today = 4 WHERE id = ?", [setup.menu]);
  const res = await pesan(isi()).expect(409);
  expect(res.body.error).toEqual({
    code: "OUT_OF_STOCK",
    message: "Sisa porsi tidak cukup.",
    fields: { "items.0.qty": ["Sisa 1 porsi."] },
  });
  expect(await hitung("orders")).toBe(0);
  expect(await hitung("order_idempotency")).toBe(0);
  expect((await menuRow(setup.menu)).held_today).toBe(4);
});

describe("validasi", () => {
  test("payment_method selain cod/va/online (termasuk qris, dihapus F26) / tidak ada → 400", async () => {
    for (const paymentMethod of ["transfer", "tunai", "qris", undefined]) {
      const res = await pesan(isi({ payment_method: paymentMethod })).expect(400);
      expect(res.body.error.fields.payment_method).toEqual(["Pilih bayar tunai, Virtual Account, atau bayar online."]);
    }
  });

  test("Idempotency-Key hilang / bukan UUID → 400", async () => {
    for (const key of [null, "abc"]) {
      const res = await pesan(isi(), key).expect(400);
      expect(res.body.error).toMatchObject({ code: "VALIDATION_ERROR", message: "Data tidak valid." });
      expect(res.body.error.fields).toEqual({ idempotency_key: ["Muat ulang aplikasi lalu coba lagi."] });
    }
  });

  test("promo → 422 tanpa pesanan", async () => {
    await pesan(isi({ promo_code: "HEMAT" })).expect(422);
    expect(await hitung("orders")).toBe(0);
  });

  test("R-14 / tutup lewat POST /orders → 409, tanpa baris tertinggal", async () => {
    await db.query("UPDATE merchants SET verification_status = 'suspended' WHERE id = ?", [setup.idA]);
    expect((await pesan(isi()).expect(409)).body.error.code).toBe("MERCHANT_UNAVAILABLE");
    await makeVisible(setup.idA, { open: false });
    expect((await pesan(isi()).expect(409)).body.error.code).toBe("MERCHANT_CLOSED");
    expect(await hitung("orders")).toBe(0);
    expect(await hitung("order_idempotency")).toBe(0);
  });
});

test("D11: 3 pesanan menunggu → ke-4 409; satu kadaluarsa → lolos", async () => {
  for (let i = 0; i < 3; i++) await pesan(isi({}, { qty: 1 })).expect(201);
  const idempotencyKey = randomUUID();
  const res = await pesan(isi({}, { qty: 1 }), idempotencyKey).expect(409);
  expect(res.body.error).toMatchObject({
    code: "CONFLICT",
    message: "Masih ada 3 pesanan yang menunggu. Selesaikan atau batalkan dulu.",
  });
  await db.query("UPDATE orders SET hold_until = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE) ORDER BY id LIMIT 1");
  await pesan(isi({}, { qty: 1 }), idempotencyKey).expect(201);
});

test("D7: kode bentrok → buat ulang; selalu bentrok → 500 tanpa sisa", async () => {
  const hari = getWibDate().replace(/-/g, "");
  vi.spyOn(codeGenerator, "random").mockReturnValueOnce("AAAA").mockReturnValueOnce("AAAA").mockReturnValueOnce("BBBB");
  expect((await pesan(isi({}, { qty: 1 })).expect(201)).body.data.code).toBe(`KK-${hari}-AAAA`);
  expect((await pesan(isi({}, { qty: 1 })).expect(201)).body.data.code).toBe(`KK-${hari}-BBBB`);
  vi.spyOn(codeGenerator, "random").mockReturnValue("AAAA");
  const idempotencyKey = randomUUID();
  const res = await pesan(isi({}, { qty: 1 }), idempotencyKey).expect(500);
  expect(res.body.error.code).toBe("INTERNAL_ERROR");
  expect(await hitung("orders")).toBe(2);
  const [rows] = await db.query<any[]>("SELECT 1 FROM order_idempotency WHERE idem_key = ?", [idempotencyKey]);
  expect(rows).toHaveLength(0);
  expect((await menuRow(setup.menu)).held_today).toBe(2);
});

test("pickup_at ikut di Order (ISO UTC)", async () => {
  const res = await pesan(isi({ pickup_at: `${getWibDate()}T13:30:00+07:00` })).expect(201);
  expect(res.body.data.pickup_at).toBe(new Date(`${getWibDate()}T13:30:00+07:00`).toISOString());
});

// Injeksi galat memakai CREATE TRIGGER; TiDB tidak punya trigger, jadi blok ini hanya jalan di MySQL
describe.skipIf(process.env.DATABASE_URL?.includes("tidbcloud.com"))("galat di tengah transaksi (D6, D7)", () => {
  afterEach(async () => {
    await db.query("DROP TRIGGER IF EXISTS uji_gagal");
  });

  test("galat setelah klaim → 500, klaim di-rollback, kunci sama boleh diulang", async () => {
    await db.query(`CREATE TRIGGER uji_gagal BEFORE INSERT ON order_items FOR EACH ROW
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'gagal uji'`);
    const idempotencyKey = randomUUID();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await pesan(isi(), idempotencyKey).expect(500);
    expect(await hitung("orders")).toBe(0);
    expect(await hitung("order_idempotency")).toBe(0);
    expect((await menuRow(setup.menu)).held_today).toBe(0);
    await db.query("DROP TRIGGER uji_gagal");
    await pesan(isi(), idempotencyKey).expect(201);
  });

  test("duplikat pada kunci selain orders.code bukan tabrakan kode → tidak dicoba ulang", async () => {
    await db.query(`CREATE TRIGGER uji_gagal BEFORE INSERT ON orders FOR EACH ROW
      SIGNAL SQLSTATE '23000' SET MESSAGE_TEXT = "Duplicate entry 'x' for key 'orders.lain'", MYSQL_ERRNO = 1062`);
    const randomSpy = vi.spyOn(codeGenerator, "random");
    const res = await pesan(isi());
    expect(res.status).not.toBe(201);
    expect(randomSpy).toHaveBeenCalledTimes(1);
    expect(await hitung("order_idempotency")).toBe(0);
  });
});

describe("GET /orders/:code", () => {
  test("pemilik 200 bentuk sama; pembeli lain / kode tak ada 404; penjual 403; tanpa token 401", async () => {
    const res = await pesan(isi()).expect(201);
    const code = res.body.data.code;
    const detailRes = await baca(code).expect(200);
    expect(Object.keys(detailRes.body.data).sort()).toEqual(KUNCI_ORDER);
    expect({ ...detailRes.body.data, seconds_left: 0 }).toEqual({ ...res.body.data, seconds_left: 0 });
    const lain = await createCustomer(1);
    const otherRes = await baca(code, lain).expect(404);
    expect(otherRes.body.error).toMatchObject({ code: "NOT_FOUND", message: "Pesanan tidak ditemukan." });
    await baca("KK-00000000-ZZZZ").expect(404);
    await baca(code, setup.tokenA).expect(403);
    await request(app).get(`/api/v1/orders/${code}`).expect(401);
  });
});
