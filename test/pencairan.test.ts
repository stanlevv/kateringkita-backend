import request from "supertest";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { passwordLimiter } from "../src/middleware/rateLimiter";
import { createAdmin } from "../src/scripts/create-admin";
import { login, pesanDulu, siapCheckout } from "./helpers/toko";

// F26: rekening pencairan penjual, saldo & pencatatan pencairan oleh admin super, daftar pengembalian dana Midtrans.
// Test berurutan dan berbagi data: saldo test 2 dicairkan di test 3.
let s: Awaited<ReturnType<typeof siapCheckout>>;
let tAdmin: string;
let asOf: string;

const get = (u: string, t: string) => request(app).get(`/api/v1${u}`).set("Authorization", `Bearer ${t}`);
const post = (u: string, b: object, t: string) => request(app).post(`/api/v1${u}`).set("Authorization", `Bearer ${t}`).send(b);
const rekening = (b: object) => request(app).put("/api/v1/merchant/payout-account").set("Authorization", `Bearer ${s.tA}`).send(b);
const cairkan = (b: object) => post("/admin/payouts", { merchant_id: s.idA, until: asOf, reference: "TRF-0001", ...b }, tAdmin);
const REKENING = { bank: "bca", account_number: "012 345-678.901", account_name: " Siti Aminah ", password: "rahasia123" };

const promo = async (merchantId: number | null, code: string) => ((await db.query<any>(
  "INSERT INTO promos (merchant_id, code, type, value, starts_at, ends_at) VALUES (?, ?, 'fixed', 2000, UTC_TIMESTAMP(), DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 DAY))",
  [merchantId, code],
))[0]).insertId as number;

// Pesanan Budi lewat checkout tunai, lalu dibentuk lewat SQL. Waktu selesai relatif ke jam DB, sama dengan as_of.
async function pesananLunas(qty: number, o: { method: string; status?: string; promo?: number; discount?: number; menit?: number }) {
  const code = await pesanDulu(s.tCust, s.menu, qty);
  await db.query(
    `UPDATE orders SET payment_method = ?, status = ?, payment_status = 'paid', promo_id = ?, discount = ?,
       completed_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE) WHERE code = ?`,
    [o.method, o.status ?? "completed", o.promo ?? null, o.discount ?? 0, o.menit ?? -60, code],
  );
  await db.query("UPDATE menus SET held_today = 0");
  return code;
}

// Pembayaran Midtrans tercatat, lalu pesanan batal (ditolak penjual) atau kedaluwarsa (dibayar setelah batas waktu)
async function bayarLaluBatal(method: string, status: "cancelled" | "expired", bayar = "paid") {
  const code = await pesanDulu(s.tCust, s.menu2);
  const tolak = status === "cancelled";
  await db.query(
    `UPDATE orders SET payment_method = ?, status = ?, payment_status = ?, cancelled_at = UTC_TIMESTAMP(), cancelled_by = ?, cancel_reason = ?
     WHERE code = ?`,
    [method, status, bayar === "paid" ? "paid" : "unpaid", tolak ? "merchant" : "system", tolak ? "Stok habis" : null, code],
  );
  await db.query(
    `INSERT INTO payments (order_id, method, provider, amount, status, paid_at)
     SELECT id, ?, 'midtrans', total, ?, IF(? = 'paid', UTC_TIMESTAMP(), NULL) FROM orders WHERE code = ?`,
    [method, bayar, bayar, code],
  );
  await db.query("UPDATE menus SET held_today = 0");
  return code;
}

beforeAll(async () => {
  s = await siapCheckout();
  passwordLimiter.reset();
  await createAdmin({ phone: "081300000009", fullName: "Admin Uji", password: "rahasia123" });
  tAdmin = await login("081300000009");
});
afterAll(() => {
  vi.restoreAllMocks();
});

test("rekening: kosong di awal; sandi salah dan isian tidak valid → 400, tidak tersimpan", async () => {
  const r = await get("/merchant/payouts", s.tA).expect(200);
  expect(r.body.data).toMatchObject({ account: null, balance: { amount: 0, orders: 0, since: null }, payouts: [] });
  expect(r.body.data.banks).toContainEqual({ code: "bca", name: "BCA" });
  expect((await rekening({ ...REKENING, password: "salah123" }).expect(400)).body.error.fields).toEqual({ password: ["Kata sandi salah."] });
  const bad = await rekening({ bank: "xyz", account_number: "12ab", account_name: "S", password: "" }).expect(400);
  expect(bad.body.error.fields).toEqual({
    bank: ["Pilih bank atau e-wallet."], account_number: ["Nomor rekening 6–20 angka."],
    account_name: ["Nama pemilik rekening 3–100 karakter."], password: ["Masukkan kata sandi akunmu."],
  });
  expect((await get("/merchant/payouts", s.tA)).body.data.account).toBeNull();
});

test("saldo: hanya VA/online lunas & selesai; bagian penjual = subtotal − promo toko", async () => {
  const toko = await promo(s.idA, "TOKO2RB");
  const platform = await promo(null, "HEMAT3RB");
  await pesananLunas(1, { method: "online" }); // 15.000
  await pesananLunas(2, { method: "va", promo: toko, discount: 2000 }); // 30.000 − 2.000 ditanggung toko
  await pesananLunas(1, { method: "online", promo: platform, discount: 3000 }); // 15.000: diskon ditanggung platform
  await pesananLunas(1, { method: "cod" }); // tunai sudah diterima penjual langsung
  await pesananLunas(1, { method: "online", status: "cooking" }); // belum selesai
  const r = await get("/admin/payouts/balances", tAdmin).expect(200);
  asOf = r.body.data.as_of;
  expect(r.body.data.rows).toEqual([
    { merchant_id: s.idA, business_name: "Dapur Siti", account: null, amount: 58000, orders: 3, since: expect.any(String) },
  ]);
  expect((await get("/merchant/payouts", s.tA)).body.data.balance).toMatchObject({ amount: 58000, orders: 3 });
});

test("catat pencairan: wajib rekening, nominal harus cocok, pesanan setelah as_of tidak ikut, tidak bisa dobel", async () => {
  expect((await cairkan({ amount: 58000 }).expect(409)).body.error.message).toBe("Penjual belum mengisi rekening pencairan.");
  const rek = await rekening(REKENING).expect(200);
  expect(rek.body.data.account).toEqual({
    bank: "bca", bank_name: "BCA", account_number: "012345678901", account_name: "Siti Aminah", updated_at: expect.any(String),
  });
  expect((await cairkan({ amount: 57000 }).expect(409)).body.error.message).toBe("Saldo penjual berubah. Muat ulang lalu periksa lagi.");
  await pesananLunas(1, { method: "online", menit: 60 }); // selesai setelah as_of: ikut pencairan berikutnya
  await db.query("UPDATE orders SET updated_at = '2026-01-01 00:00:00' WHERE merchant_id = ?", [s.idA]);
  const r = await cairkan({ amount: 58000, note: " Transfer BCA " }).expect(201);
  expect(r.body.data).toMatchObject({
    merchant_id: s.idA, business_name: "Dapur Siti", amount: 58000, orders_count: 3, bank: "bca", bank_name: "BCA",
    account_number: "012345678901", account_name: "Siti Aminah", reference: "TRF-0001", note: "Transfer BCA", admin_name: "Admin Uji",
  });
  const [ikut] = await db.query<any[]>("SELECT DATE_FORMAT(updated_at, '%Y-%m-%d') AS u FROM orders WHERE payout_id = ?", [r.body.data.id]);
  expect(ikut.map((o) => o.u)).toEqual(["2026-01-01", "2026-01-01", "2026-01-01"]); // pesanan tidak "berubah" bagi sinkron updated_since
  expect((await cairkan({ amount: 58000 }).expect(409)).body.error.message).toBe("Tidak ada saldo untuk dicairkan.");

  const m = (await get("/merchant/payouts", s.tA).expect(200)).body.data;
  expect(m.balance).toMatchObject({ amount: 15000, orders: 1 });
  expect(m.payouts).toMatchObject([{ id: r.body.data.id, amount: 58000, reference: "TRF-0001", account_number: "012345678901" }]);
  const h = await get("/admin/payouts", tAdmin).expect(200);
  expect(h.body.meta).toEqual({ page: 1, limit: 20, total: 1 });
  expect(h.body.data).toMatchObject([{ id: r.body.data.id, amount: 58000, admin_name: "Admin Uji" }]);
  const [[log]] = await db.query<any[]>("SELECT target_type, target_id, after_json FROM admin_audit_logs WHERE action = 'payout.create'");
  expect(log).toMatchObject({ target_type: "merchant", target_id: String(s.idA) });
  expect(log.after_json).toEqual({ payout_id: r.body.data.id, amount: 58000, orders: 3, reference: "TRF-0001" });
});

test("validasi pencairan → 400; penjual tidak dikenal → 404", async () => {
  const r = await post("/admin/payouts", { merchant_id: s.idA, amount: 0, until: "kemarin", reference: "x" }, tAdmin).expect(400);
  expect(r.body.error.fields).toEqual({
    amount: ["Nominal tidak valid."], until: ["Waktu saldo tidak valid. Muat ulang halaman."], reference: ["Nomor referensi transfer 3–100 karakter."],
  });
  expect((await cairkan({ merchant_id: 9999, amount: 1000 }).expect(404)).body.error.message).toBe("Penjual tidak ditemukan.");
});

test("pengembalian dana: hanya dana Midtrans lunas dari pesanan batal/kedaluwarsa; ditandai sekali", async () => {
  const tolak = await bayarLaluBatal("online", "cancelled");
  const telat = await bayarLaluBatal("va", "expired");
  await bayarLaluBatal("online", "cancelled", "expired"); // tidak pernah dibayar
  const cod = await pesanDulu(s.tCust, s.menu2);
  await db.query("UPDATE orders SET status = 'cancelled' WHERE code = ?", [cod]); // tunai: tidak ada dana masuk
  await db.query("UPDATE menus SET held_today = 0");

  const r = await get("/admin/refunds", tAdmin).expect(200);
  expect(r.body.data.map((x: { code: string }) => x.code)).toEqual([tolak, telat]);
  expect(r.body.data[0]).toMatchObject({
    status: "cancelled", method: "online", customer_name: "Budi", business_name: "Dapur Siti", dine_in: false,
    cancelled_by: "merchant", cancel_reason: "Stok habis", paid_at: expect.any(String),
  });
  const t = await post(`/admin/refunds/${tolak}`, { reference: " RF-0001 " }, tAdmin).expect(200);
  expect(t.body.data).toEqual({ code: tolak, amount: r.body.data[0].amount, reference: "RF-0001" });
  const [[p]] = await db.query<any[]>(
    "SELECT p.status, p.refund_ref, p.refunded_at, o.payment_status FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.code = ?", [tolak],
  );
  expect(p).toMatchObject({ status: "refunded", refund_ref: "RF-0001", payment_status: "refunded" });
  expect(p.refunded_at).not.toBeNull();
  expect((await get("/admin/refunds", tAdmin)).body.data.map((x: { code: string }) => x.code)).toEqual([telat]);
  const lagi = await post(`/admin/refunds/${tolak}`, { reference: "RF-0001" }, tAdmin).expect(404);
  expect(lagi.body.error.message).toBe("Tidak ada dana yang perlu dikembalikan untuk pesanan ini.");
  await post(`/admin/refunds/${cod}`, { reference: "RF-0002" }, tAdmin).expect(404);
  expect((await post(`/admin/refunds/${telat}`, { reference: "x" }, tAdmin).expect(400)).body.error.fields)
    .toEqual({ reference: ["Nomor referensi transfer 3–100 karakter."] });
  const [[log]] = await db.query<any[]>("SELECT target_type, target_id, after_json FROM admin_audit_logs WHERE action = 'refund.mark'");
  expect(log).toEqual({ target_type: "order", target_id: tolak, after_json: { amount: t.body.data.amount, reference: "RF-0001" } });
});

test("akses: pencairan & pengembalian dana hanya admin super; rekening hanya penjual", async () => {
  await createAdmin({ phone: "081300000008", fullName: "Admin Ops", password: "rahasia123" });
  await db.query("UPDATE users SET admin_level = 'ops' WHERE phone = '081300000008'");
  const tOps = await login("081300000008");
  for (const t of [tOps, s.tA, s.tCust]) {
    await get("/admin/payouts/balances", t).expect(403);
    await get("/admin/payouts", t).expect(403);
    await get("/admin/refunds", t).expect(403);
    await post("/admin/payouts", { merchant_id: s.idA, amount: 15000, until: asOf, reference: "TRF-0002" }, t).expect(403);
  }
  await get("/merchant/payouts", s.tCust).expect(403);
  await get("/merchant/payouts", tAdmin).expect(403);
  await request(app).get("/api/v1/merchant/payouts").expect(401);
  expect((await db.query<any[]>("SELECT COUNT(*) AS n FROM payouts"))[0][0].n).toBe(1);
});
