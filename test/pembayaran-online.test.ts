import { createHash, randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { env } from "../src/config/env";
import { menuRow, pembeliBaru, pesanDulu, siapCheckout } from "./helpers/toko";

// F26: QRIS statis toko (verifikasi manual) dihapus; pre-order bayar online lewat Snap Midtrans (di-stub) → notifikasi → diterima otomatis
let s: Awaited<ReturnType<typeof siapCheckout>>;
const KEY = "SB-Mid-server-uji";
const SNAP = "https://app.sandbox.midtrans.com/snap/v4/redirection/pre-order";

const pesan = (payment_method: string, token = s.tCust) => request(app).post("/api/v1/orders").set("Authorization", `Bearer ${token}`)
  .set("Idempotency-Key", randomUUID()).send({ items: [{ menu_id: s.menu, qty: 2 }], pickup_point_id: 1, payment_method });
const bayar = (code: string, body?: object, token = s.tCust) =>
  request(app).post(`/api/v1/orders/${code}/online`).set("Authorization", `Bearer ${token}`).send(body);
const notif = (o: Record<string, string>) => {
  const n = { status_code: "200", transaction_status: "settlement", payment_type: "qris", transaction_id: `trx-${o.order_id}`, ...o };
  const signature_key = createHash("sha512").update(`${n.order_id}${n.status_code}${n.gross_amount}${KEY}`).digest("hex");
  return request(app).post("/api/v1/payments/midtrans").send({ ...n, signature_key });
};
const pesanan = async (code: string) => ((await db.query<any[]>("SELECT * FROM orders WHERE code = ?", [code]))[0] as any[])[0];
const stubSnap = () => {
  const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ token: "snap-uji", redirect_url: SNAP })));
  vi.stubGlobal("fetch", f);
  return f;
};

beforeAll(async () => {
  s = await siapCheckout();
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
    expect((await pesan("qris").expect(400)).body.error.fields.payment_method).toEqual(["Pilih bayar tunai, Virtual Account, atau bayar online."]);
    const r = await pesan("online").expect(409);
    expect(r.body.error).toEqual({ code: "CONFLICT", message: "Pembayaran online belum tersedia. Pilih metode lain." });
    expect((await menuRow(s.menu)).held_today).toBe(0);
  });

  test("online → holding unpaid; payment_url null sampai halaman bayar dibuka; tanpa qris_image_url toko", async () => {
    env.MIDTRANS_SERVER_KEY = KEY;
    const r = await pesan("online").expect(201);
    expect(r.body.data).toMatchObject({ status: "holding", payment_method: "online", payment_status: "unpaid" });
    expect(r.body.data.payment).toEqual({ method: "online", status: "unpaid", amount: 30000, payment_url: null });
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
    const baca = await request(app).get(`/api/v1/orders/${code}`).set("Authorization", `Bearer ${s.tCust}`).expect(200);
    expect(baca.body.data.payment).toMatchObject({ status: "paid", payment_url: null });
    expect((await bayar(code).expect(409)).body.error.message).toBe("Pesanan ini tidak menunggu pembayaran.");
  });

  test("kembali web sendiri jadi callback; asal lain 400; pesanan tunai 409; pembeli lain 404; penjual 403", async () => {
    env.MIDTRANS_SERVER_KEY = KEY;
    const code = (await pesan("online").expect(201)).body.data.code;
    const f = stubSnap();
    expect((await bayar(code, { kembali: "https://jahat.example/x" }).expect(400)).body.error.fields.kembali).toEqual(["Alamat kembali tidak diizinkan."]);
    await bayar(code, { kembali: "http://localhost:3000/pesanan/x" }).expect(200);
    expect(JSON.parse(f.mock.calls[0][1].body).callbacks).toEqual({ finish: "http://localhost:3000/pesanan/x" });
    const cod = await pesanDulu(s.tCust, s.menu2);
    expect((await bayar(cod).expect(409)).body.error.message).toBe("Pesanan ini tidak memakai bayar online.");
    await bayar(code, undefined, await pembeliBaru(1)).expect(404);
    await bayar(code, undefined, s.tA).expect(403);
  });
});

describe("penjual tidak bisa melunasi manual", () => {
  test("POST /merchant/orders/:code/pay → 404; konfirmasi sebelum lunas → 409", async () => {
    env.MIDTRANS_SERVER_KEY = KEY;
    const code = (await pesan("online").expect(201)).body.data.code;
    const aksi = (a: string) => request(app).post(`/api/v1/merchant/orders/${code}/${a}`).set("Authorization", `Bearer ${s.tA}`);
    await aksi("pay").expect(404);
    expect((await aksi("confirm").expect(409)).body.error.message).toBe("Pesanan belum dibayar.");
    expect((await pesanan(code)).payment_status).toBe("unpaid");
  });
});
