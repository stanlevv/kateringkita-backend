import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { env } from "../src/config/env";
import { sendNotification } from "./helpers/midtrans";
import { menuRow, createCustomer, placeOrder, prepareCheckout } from "./helpers/merchant";

// F26: QRIS statis toko (verifikasi manual) dihapus; pre-order bayar online lewat Snap Midtrans (di-stub) → notifikasi → diterima otomatis
let s: Awaited<ReturnType<typeof prepareCheckout>>;
const KEY = "SB-Mid-server-uji";
const SNAP = "https://app.sandbox.midtrans.com/snap/v4/redirection/pre-order";

const pesan = (payment_method: string, token = s.customerToken) =>
  request(app)
    .post("/api/v1/orders")
    .set("Authorization", `Bearer ${token}`)
    .set("Idempotency-Key", randomUUID())
    .send({ items: [{ menu_id: s.menu, qty: 2 }], pickup_point_id: 1, payment_method });
const bayar = (code: string, body?: object, token = s.customerToken) =>
  request(app).post(`/api/v1/orders/${code}/online`).set("Authorization", `Bearer ${token}`).send(body);
const notif = (o: Record<string, string>) =>
  sendNotification(
    {
      status_code: "200",
      transaction_status: "settlement",
      payment_type: "qris",
      transaction_id: `trx-${o.order_id}`,
      ...o,
    },
    KEY,
  );
const pesanan = async (code: string) =>
  ((await db.query<any[]>("SELECT * FROM orders WHERE code = ?", [code]))[0] as any[])[0];
const stubSnap = () => {
  const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ token: "snap-uji", redirect_url: SNAP })));
  vi.stubGlobal("fetch", f);
  return f;
};

beforeAll(async () => {
  s = await prepareCheckout();
  // .env lokal boleh berisi key sandbox; tes mulai tanpa Midtrans dan selalu sandbox
  env.MIDTRANS_SERVER_KEY = undefined;
  env.MIDTRANS_IS_PRODUCTION = "false";
});
// batas 3 holding per pembeli (D11)
afterEach(async () => {
  env.MIDTRANS_SERVER_KEY = undefined;
  vi.unstubAllGlobals();
  await db.query("UPDATE orders SET status = 'expired' WHERE status = 'holding'");
  await db.query("UPDATE menus SET held_today = 0");
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("checkout", () => {
  test("QRIS toko tidak diterima lagi → 400; online tanpa server key → 409 tanpa pesanan", async () => {
    expect((await pesan("qris").expect(400)).body.error.fields.payment_method).toEqual([
      "Pilih bayar tunai, Virtual Account, atau bayar online.",
    ]);
    const r = await pesan("online").expect(409);
    expect(r.body.error).toEqual({ code: "CONFLICT", message: "Pembayaran online belum tersedia. Pilih metode lain." });
    expect((await menuRow(s.menu)).held_today).toBe(0);
  });

  test("online → holding unpaid; payment_url null sampai halaman bayar dibuka; tanpa qris_image_url toko", async () => {
    env.MIDTRANS_SERVER_KEY = KEY;
    const r = await pesan("online").expect(201);
    expect(r.body.data).toMatchObject({ status: "holding", payment_method: "online", payment_status: "unpaid" });
    expect(r.body.data.payment).toEqual({
      method: "online",
      status: "unpaid",
      amount: 30000,
      payment_url: null,
      qris: null,
    });
    expect(r.body.data.merchant).not.toHaveProperty("qris_image_url");
  });
});

describe("POST /orders/:code/online", () => {
  test("Snap dibuat sekali (idempoten), tanpa callback bila tanpa kembali; settlement → confirmed + paid, payment_url hilang", async () => {
    env.MIDTRANS_SERVER_KEY = KEY;
    const { code, total } = (await pesan("online").expect(201)).body.data;
    const f = stubSnap();
    expect((await bayar(code).expect(200)).body.data.payment).toMatchObject({ status: "pending", payment_url: SNAP });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://app.sandbox.midtrans.com/snap/v1/transactions");
    const kirim = JSON.parse(init.body);
    expect(kirim).toMatchObject({ transaction_details: { order_id: code, gross_amount: total } });
    expect(kirim).not.toHaveProperty("callbacks");
    await bayar(code).expect(200);
    expect(f).toHaveBeenCalledTimes(1);
    await notif({ order_id: code, gross_amount: `${total}.00` }).expect(200);
    expect(await pesanan(code)).toMatchObject({ status: "confirmed", payment_status: "paid" });
    const baca = await request(app)
      .get(`/api/v1/orders/${code}`)
      .set("Authorization", `Bearer ${s.customerToken}`)
      .expect(200);
    expect(baca.body.data.payment).toMatchObject({ status: "paid", payment_url: null });
    expect((await bayar(code).expect(409)).body.error.message).toBe("Pesanan ini tidak menunggu pembayaran.");
  });

  test("kembali web sendiri jadi callback; asal lain 400; pesanan tunai 409; pembeli lain 404; penjual 403", async () => {
    env.MIDTRANS_SERVER_KEY = KEY;
    const code = (await pesan("online").expect(201)).body.data.code;
    const f = stubSnap();
    expect((await bayar(code, { kembali: "https://jahat.example/x" }).expect(400)).body.error.fields.kembali).toEqual([
      "Alamat kembali tidak diizinkan.",
    ]);
    await bayar(code, { kembali: "http://localhost:3000/pesanan/x" }).expect(200);
    expect(JSON.parse(f.mock.calls[0][1].body).callbacks).toEqual({ finish: "http://localhost:3000/pesanan/x" });
    const cod = await placeOrder(s.customerToken, s.menu2);
    expect((await bayar(cod).expect(409)).body.error.message).toBe("Pesanan ini tidak memakai bayar online.");
    await bayar(code, undefined, await createCustomer(1)).expect(404);
    await bayar(code, undefined, s.tokenA).expect(403);
  });
});

// QRIS langsung di aplikasi: charge Core API payment_type qris → qr_string digambar sendiri oleh aplikasi (tanpa halaman Snap)
describe("POST /orders/:code/qris", () => {
  const QR_URL = (id: string) => `https://api.sandbox.midtrans.com/v2/qris/${id}/qr-code`;
  const qris = (code: string, token = s.customerToken) =>
    request(app).post(`/api/v1/orders/${code}/qris`).set("Authorization", `Bearer ${token}`).send();
  const stubCharge = (balas: Record<string, unknown>) => {
    const f = vi.fn().mockImplementation(async () => new Response(JSON.stringify(balas)));
    vi.stubGlobal("fetch", f);
    return f;
  };
  const chargeQris = (code: string, total: number) => ({
    status_code: "201",
    status_message: "QRIS transaction is created",
    transaction_id: `trx-${code}`,
    order_id: code,
    gross_amount: `${total}.00`,
    payment_type: "qris",
    transaction_status: "pending",
    qr_string: `00020101021226QR-${code}`,
    actions: [{ name: "generate-qr-code", method: "GET", url: QR_URL(`trx-${code}`) }],
  });

  test("charge QRIS sekali (idempoten) → qr_string + qr_url; settlement → confirmed + paid, qris hilang", async () => {
    env.MIDTRANS_SERVER_KEY = KEY;
    const { code, total } = (await pesan("online").expect(201)).body.data;
    const f = stubCharge(chargeQris(code, total));
    const r = await qris(code).expect(200);
    expect(r.body.data.payment).toMatchObject({
      method: "online",
      status: "pending",
      payment_url: null,
      qris: { qr_string: `00020101021226QR-${code}`, qr_url: QR_URL(`trx-${code}`) },
    });
    expect(new Date(r.body.data.payment.qris.expires_at).getTime()).toBeGreaterThan(Date.now());
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://api.sandbox.midtrans.com/v2/charge");
    expect(JSON.parse(init.body)).toMatchObject({
      payment_type: "qris",
      qris: { acquirer: "gopay" },
      transaction_details: { order_id: code, gross_amount: total },
      custom_expiry: { unit: "minute" },
    });
    // permintaan ulang memakai QR yang sama, tidak charge lagi
    expect((await qris(code).expect(200)).body.data.payment.qris.qr_string).toBe(`00020101021226QR-${code}`);
    expect(f).toHaveBeenCalledTimes(1);
    // GET pesanan juga membawa QR selama menunggu bayar
    const baca = () =>
      request(app).get(`/api/v1/orders/${code}`).set("Authorization", `Bearer ${s.customerToken}`).expect(200);
    expect((await baca()).body.data.payment.qris.qr_url).toBe(QR_URL(`trx-${code}`));
    await notif({ order_id: code, gross_amount: `${total}.00`, transaction_id: `trx-${code}` }).expect(200);
    expect(await pesanan(code)).toMatchObject({ status: "confirmed", payment_status: "paid" });
    expect((await baca()).body.data.payment).toMatchObject({ status: "paid", qris: null });
    const [[p]] = await db.query<any[]>(
      "SELECT p.method, p.status FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.code = ?",
      [code],
    );
    expect(p).toMatchObject({ method: "qris", status: "paid" });
    expect((await qris(code).expect(409)).body.error.message).toBe("Pesanan ini tidak menunggu pembayaran.");
  });

  test("halaman Snap sudah dibuka lalu QRIS dibayar → baris QRIS (bukan Snap) yang lunas", async () => {
    env.MIDTRANS_SERVER_KEY = KEY;
    const { code, total } = (await pesan("online").expect(201)).body.data;
    stubSnap();
    await bayar(code).expect(200);
    stubCharge(chargeQris(code, total));
    await qris(code).expect(200);
    await notif({ order_id: code, gross_amount: `${total}.00`, transaction_id: `trx-${code}` }).expect(200);
    const [rows] = await db.query<any[]>(
      "SELECT p.method, p.status FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.code = ? ORDER BY p.id",
      [code],
    );
    expect(rows).toEqual([
      { method: "online", status: "pending" },
      { method: "qris", status: "paid" },
    ]);
  });

  test("order_id sudah dipakai di halaman Midtrans (406) → 409; Midtrans gagal → 502; keduanya tanpa baris QRIS", async () => {
    env.MIDTRANS_SERVER_KEY = KEY;
    const code = (await pesan("online").expect(201)).body.data.code;
    stubCharge({
      status_code: "406",
      status_message:
        "The request could not be completed due to a conflict with the current state of the target resource",
    });
    expect((await qris(code).expect(409)).body.error.message).toBe(
      "Pembayaran pesanan ini sudah dimulai di halaman Midtrans. Lanjutkan di sana.",
    );
    stubCharge({ status_code: "500", status_message: "Internal error" });
    expect((await qris(code).expect(502)).body.error.message).toBe("Gagal membuat QRIS. Coba lagi.");
    const [[n]] = await db.query<any[]>(
      "SELECT COUNT(*) AS n FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.code = ?",
      [code],
    );
    expect(Number(n.n)).toBe(0);
  });

  test("pesanan tunai 409; pembeli lain 404; penjual 403", async () => {
    env.MIDTRANS_SERVER_KEY = KEY;
    const code = (await pesan("online").expect(201)).body.data.code;
    const cod = await placeOrder(s.customerToken, s.menu2);
    expect((await qris(cod).expect(409)).body.error.message).toBe("Pesanan ini tidak memakai bayar online.");
    await qris(code, await createCustomer(2)).expect(404);
    await qris(code, s.tokenA).expect(403);
  });
});

describe("penjual tidak bisa melunasi manual", () => {
  test("POST /merchant/orders/:code/pay → 404; konfirmasi sebelum lunas → 409", async () => {
    env.MIDTRANS_SERVER_KEY = KEY;
    const code = (await pesan("online").expect(201)).body.data.code;
    const aksi = (a: string) =>
      request(app).post(`/api/v1/merchant/orders/${code}/${a}`).set("Authorization", `Bearer ${s.tokenA}`);
    await aksi("pay").expect(404);
    expect((await aksi("confirm").expect(409)).body.error.message).toBe("Pesanan belum dibayar.");
    expect((await pesanan(code)).payment_status).toBe("unpaid");
  });
});
