import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { env } from "../src/config/env";
import { sendNotification } from "./helpers/midtrans";
import { menuRow, placeOrder, prepareCheckout } from "./helpers/merchant";

// VA Midtrans — checkout VA, POST /orders/:code/va (Midtrans di-stub), notifikasi POST /payments/midtrans
let setup: Awaited<ReturnType<typeof prepareCheckout>>;
const KEY = "SB-Mid-server-uji";
const VA_NUMBER = "8127000012345";

const placeVaOrder = () =>
  request(app)
    .post("/api/v1/orders")
    .set("Authorization", `Bearer ${setup.customerToken}`)
    .set("Idempotency-Key", randomUUID())
    .send({ items: [{ menu_id: setup.menu, qty: 2 }], pickup_point_id: 1, payment_method: "va" });
const requestVa = (code: string, bank: unknown = "bca") =>
  request(app).post(`/api/v1/orders/${code}/va`).set("Authorization", `Bearer ${setup.customerToken}`).send({ bank });
const postNotification = (fields: Record<string, string>, key = KEY, honest = true) =>
  sendNotification(
    {
      status_code: "200",
      gross_amount: "30000.00",
      transaction_status: "settlement",
      payment_type: "bank_transfer",
      ...fields,
    },
    key,
    honest,
  );
// Response baru tiap panggilan: body Response hanya bisa dibaca sekali (charge lalu Get Status)
const midtrans = (code: string) =>
  vi.fn().mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          status_code: "201",
          transaction_id: `trx-${code}`,
          order_id: code,
          gross_amount: "30000.00",
          transaction_status: "pending",
          va_numbers: [{ bank: "bca", va_number: VA_NUMBER }],
        }),
      ),
  );
const orderRow = async (code: string) =>
  ((await db.query<any[]>("SELECT * FROM orders WHERE code = ?", [code]))[0] as any[])[0];
const pay = async (code: string) =>
  (
    await db.query<any[]>("SELECT p.* FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.code = ?", [code])
  )[0] as any[];
// pesanan VA dengan VA tertunda
const prepareVaOrder = async () => {
  env.MIDTRANS_SERVER_KEY = KEY;
  const code = (await placeVaOrder().expect(201)).body.data.code;
  vi.stubGlobal("fetch", midtrans(code));
  await requestVa(code).expect(200);
  return code as string;
};

beforeAll(async () => {
  setup = await prepareCheckout();
  // abaikan nilai dari .env lokal: tanpa key di awal, selalu sandbox
  env.MIDTRANS_SERVER_KEY = undefined;
  env.MIDTRANS_IS_PRODUCTION = "false";
});
// batas 3 holding per pembeli
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
    const res = await placeVaOrder().expect(409);
    expect(res.body.error).toEqual({
      code: "CONFLICT",
      message: "Pembayaran Virtual Account belum tersedia. Pilih metode lain.",
    });
    expect((await menuRow(setup.menu)).held_today).toBe(0);
  });

  test("VA dibuat sekali: request Midtrans benar, Order memuat nomor VA, permintaan ulang tanpa charge baru", async () => {
    env.MIDTRANS_SERVER_KEY = KEY;
    const res = await placeVaOrder().expect(201);
    const code = res.body.data.code;
    expect(res.body.data.payment).toEqual({ method: "va", status: "unpaid", amount: 30000, va: null });
    const fetch = midtrans(code);
    vi.stubGlobal("fetch", fetch);
    expect((await requestVa(code, "mandiri").expect(400)).body.error.fields.bank).toEqual([
      "Pilih bank BCA, BNI, atau BRI.",
    ]);
    const vaRes = await requestVa(code).expect(200);
    expect(vaRes.body.data.payment).toMatchObject({
      method: "va",
      status: "pending",
      amount: 30000,
      va: { bank: "bca", va_number: VA_NUMBER },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.sandbox.midtrans.com/v2/charge");
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from(`${KEY}:`).toString("base64")}`);
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      payment_type: "bank_transfer",
      transaction_details: { order_id: code, gross_amount: 30000 },
      bank_transfer: { bank: "bca" },
    });
    expect(body.custom_expiry.unit).toBe("minute");
    expect(body.custom_expiry.expiry_duration).toBeGreaterThanOrEqual(1);
    // idempoten: VA lama dikembalikan walau bank lain diminta, Midtrans tidak dipanggil lagi
    expect((await requestVa(code, "bni").expect(200)).body.data.payment.va.va_number).toBe(VA_NUMBER);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await pay(code)).toHaveLength(1);
    // pesanan tunai tidak bisa minta VA
    await requestVa(await placeOrder(setup.customerToken, setup.menu)).expect(409);
  });
});

describe("notifikasi Midtrans", () => {
  test("settlement sah → confirmed, lunas, stok terjual; notifikasi berulang aman", async () => {
    const code = await prepareVaOrder();
    const before = await menuRow(setup.menu);
    await postNotification({ order_id: code }).expect(200);
    expect(await orderRow(code)).toMatchObject({ status: "confirmed", payment_status: "paid" });
    const [payment] = await pay(code);
    expect(payment).toMatchObject({
      status: "paid",
      provider: "midtrans",
      method: "va",
      va_number: VA_NUMBER,
      provider_ref: `trx-${code}`,
    });
    expect(payment.paid_at).not.toBeNull();
    const after = await menuRow(setup.menu);
    expect(after.held_today).toBe(before.held_today - 2);
    expect(after.sold_today).toBe(before.sold_today + 2);
    await postNotification({ order_id: code }).expect(200);
    expect((await orderRow(code)).status).toBe("confirmed");
    expect(await pay(code)).toHaveLength(1);
  });

  test("signature salah → 403; nominal beda / pending tidak melunasi; expire menandai VA kedaluwarsa", async () => {
    const code = await prepareVaOrder();
    expect((await postNotification({ order_id: code }, "kunci-palsu").expect(403)).body.error.code).toBe("FORBIDDEN");
    await postNotification({ order_id: code, gross_amount: "1000.00" }).expect(200);
    await postNotification({ order_id: code, transaction_status: "pending" }).expect(200);
    expect(await orderRow(code)).toMatchObject({ status: "holding", payment_status: "pending" });
    expect((await pay(code))[0].status).toBe("pending");
    await postNotification({ order_id: code, transaction_status: "expire" }).expect(200);
    expect((await pay(code))[0].status).toBe("expired");
  });

  // Cek ulang status: transaction_status tidak ikut ditandatangani; body pending asli (201) yang statusnya diganti tidak boleh melunasi
  test("body bertanda tangan sah dengan status diganti settlement → dicek ke Get Status Midtrans (masih pending), tidak lunas", async () => {
    const code = await prepareVaOrder();
    await postNotification({ order_id: code, status_code: "201", transaction_status: "settlement" }, KEY, false).expect(
      200,
    );
    expect(await orderRow(code)).toMatchObject({ status: "holding", payment_status: "pending" });
    expect((await pay(code))[0].status).toBe("pending");
    expect(vi.mocked(fetch).mock.calls.at(-1)?.[0]).toBe(`https://api.sandbox.midtrans.com/v2/${code}/status`);
  });
});
