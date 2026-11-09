import { createHash, randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { env } from "../src/config/env";
import { menuRow, pesanDulu, siapCheckout } from "./helpers/toko";

// F10: VA Midtrans — checkout VA, POST /orders/:code/va (Midtrans di-stub), notifikasi POST /payments/midtrans
let s: Awaited<ReturnType<typeof siapCheckout>>;
const KEY = "SB-Mid-server-uji";
const VA = "8127000012345";

const pesanVa = () => request(app).post("/api/v1/orders").set("Authorization", `Bearer ${s.tCust}`).set("Idempotency-Key", randomUUID())
  .send({ items: [{ menu_id: s.menu, qty: 2 }], pickup_point_id: 1, payment_method: "va" });
const mintaVa = (code: string, bank: unknown = "bca") =>
  request(app).post(`/api/v1/orders/${code}/va`).set("Authorization", `Bearer ${s.tCust}`).send({ bank });
// signature sama dengan Midtrans: SHA512(order_id + status_code + gross_amount + server key)
const notif = (o: Record<string, string>, key = KEY) => {
  const n = { status_code: "200", gross_amount: "30000.00", transaction_status: "settlement", payment_type: "bank_transfer", ...o };
  const signature_key = createHash("sha512").update(`${n.order_id}${n.status_code}${n.gross_amount}${key}`).digest("hex");
  return request(app).post("/api/v1/payments/midtrans").send({ ...n, signature_key });
};
const midtrans = (code: string) => vi.fn().mockResolvedValue(new Response(JSON.stringify({
  status_code: "201", transaction_id: `trx-${code}`, order_id: code, gross_amount: "30000.00", transaction_status: "pending",
  va_numbers: [{ bank: "bca", va_number: VA }],
})));
const pesanan = async (code: string) => ((await db.query<any[]>("SELECT * FROM orders WHERE code = ?", [code]))[0] as any[])[0];
const bayar = async (code: string) =>
  (await db.query<any[]>("SELECT p.* FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.code = ?", [code]))[0] as any[];
// pesanan VA dengan VA tertunda
const siapVa = async () => {
  env.MIDTRANS_SERVER_KEY = KEY;
  const code = (await pesanVa().expect(201)).body.data.code;
  vi.stubGlobal("fetch", midtrans(code));
  await mintaVa(code).expect(200);
  return code as string;
};

beforeAll(async () => {
  s = await siapCheckout();
  // abaikan nilai dari .env lokal: tanpa key di awal, selalu sandbox
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

describe("membuat VA", () => {
  test("tanpa MIDTRANS_SERVER_KEY → checkout VA 409, stok tidak ditahan", async () => {
    const r = await pesanVa().expect(409);
    expect(r.body.error).toEqual({ code: "CONFLICT", message: "Pembayaran Virtual Account belum tersedia. Pilih metode lain." });
    expect((await menuRow(s.menu)).held_today).toBe(0);
  });

  test("VA dibuat sekali: request Midtrans benar, Order memuat nomor VA, permintaan ulang tanpa charge baru", async () => {
    env.MIDTRANS_SERVER_KEY = KEY;
    const r = await pesanVa().expect(201);
    const code = r.body.data.code;
    expect(r.body.data.payment).toEqual({ method: "va", status: "unpaid", amount: 30000, va: null });
    const fetch = midtrans(code);
    vi.stubGlobal("fetch", fetch);
    expect((await mintaVa(code, "mandiri").expect(400)).body.error.fields.bank).toEqual(["Pilih bank BCA, BNI, atau BRI."]);
    const v = await mintaVa(code).expect(200);
    expect(v.body.data.payment).toMatchObject({ method: "va", status: "pending", amount: 30000, va: { bank: "bca", va_number: VA } });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.sandbox.midtrans.com/v2/charge");
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from(`${KEY}:`).toString("base64")}`);
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ payment_type: "bank_transfer", transaction_details: { order_id: code, gross_amount: 30000 }, bank_transfer: { bank: "bca" } });
    expect(body.custom_expiry.unit).toBe("minute");
    expect(body.custom_expiry.expiry_duration).toBeGreaterThanOrEqual(1);
    // idempoten: VA lama dikembalikan walau bank lain diminta, Midtrans tidak dipanggil lagi
    expect((await mintaVa(code, "bni").expect(200)).body.data.payment.va.va_number).toBe(VA);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await bayar(code)).toHaveLength(1);
    // pesanan tunai tidak bisa minta VA
    await mintaVa(await pesanDulu(s.tCust, s.menu)).expect(409);
  });
});

describe("notifikasi Midtrans", () => {
  test("settlement sah → confirmed, lunas, stok terjual; notifikasi berulang aman", async () => {
    const code = await siapVa();
    const sebelum = await menuRow(s.menu);
    await notif({ order_id: code }).expect(200);
    expect(await pesanan(code)).toMatchObject({ status: "confirmed", payment_status: "paid" });
    const [p] = await bayar(code);
    expect(p).toMatchObject({ status: "paid", provider: "midtrans", method: "va", va_number: VA, provider_ref: `trx-${code}` });
    expect(p.paid_at).not.toBeNull();
    const sesudah = await menuRow(s.menu);
    expect(sesudah.held_today).toBe(sebelum.held_today - 2);
    expect(sesudah.sold_today).toBe(sebelum.sold_today + 2);
    await notif({ order_id: code }).expect(200);
    expect((await pesanan(code)).status).toBe("confirmed");
    expect(await bayar(code)).toHaveLength(1);
  });

  test("signature salah → 403; nominal beda / pending tidak melunasi; expire menandai VA kedaluwarsa", async () => {
    const code = await siapVa();
    expect((await notif({ order_id: code }, "kunci-palsu").expect(403)).body.error.code).toBe("FORBIDDEN");
    await notif({ order_id: code, gross_amount: "1000.00" }).expect(200);
    await notif({ order_id: code, transaction_status: "pending" }).expect(200);
    expect(await pesanan(code)).toMatchObject({ status: "holding", payment_status: "pending" });
    expect((await bayar(code))[0].status).toBe("pending");
    await notif({ order_id: code, transaction_status: "expire" }).expect(200);
    expect((await bayar(code))[0].status).toBe("expired");
  });
});
