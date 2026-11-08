import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { menuRow, pesanDulu, siapCheckout } from "./helpers/toko";

// F10: checkout QRIS + POST /merchant/orders/:code/pay (verifikasi manual penjual)
let s: Awaited<ReturnType<typeof siapCheckout>>;
const QRIS = "https://foto.test/merchants/1/qris/a.png";

const pesanQris = (token = s.tCust) => request(app).post("/api/v1/orders").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", randomUUID())
  .send({ items: [{ menu_id: s.menu, qty: 2 }], pickup_point_id: 1, payment_method: "qris" });
const aksi = (code: string, a: string, token = s.tA) =>
  request(app).post(`/api/v1/merchant/orders/${code}/${a}`).set("Authorization", `Bearer ${token}`);
const pesanan = async (code: string) => ((await db.query<any[]>("SELECT * FROM orders WHERE code = ?", [code]))[0] as any[])[0];

beforeAll(async () => {
  s = await siapCheckout();
});
// batas 3 holding per pembeli (D11)
afterEach(async () => {
  await db.query("UPDATE orders SET status = 'expired' WHERE status = 'holding'");
  await db.query("UPDATE menus SET held_today = 0");
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("checkout QRIS", () => {
  test("toko tanpa QRIS → 409, tidak ada pesanan", async () => {
    const r = await pesanQris().expect(409);
    expect(r.body.error).toEqual({ code: "CONFLICT", message: "Toko belum memasang QRIS. Pilih bayar tunai." });
    expect((await menuRow(s.menu)).held_today).toBe(0);
  });

  test("toko ber-QRIS → holding unpaid, pembeli melihat QRIS toko", async () => {
    await db.query("UPDATE merchants SET qris_image_url = ? WHERE id = ?", [QRIS, s.idA]);
    const r = await pesanQris().expect(201);
    expect(r.body.data).toMatchObject({ status: "holding", payment_method: "qris", payment_status: "unpaid", merchant: { qris_image_url: QRIS } });
    expect(r.body.data.payment).toEqual({ method: "qris", status: "unpaid", amount: 30000 });
  });
});

describe("pay", () => {
  test("holding QRIS → confirmed + paid, payments manual, stok terjual, notifikasi", async () => {
    const code = (await pesanQris().expect(201)).body.data.code;
    await aksi(code, "confirm").expect(409);
    const r = await aksi(code, "pay").expect(200);
    expect(r.body.data).toMatchObject({ code, status: "confirmed", payment_status: "paid" });
    const o = await pesanan(code);
    const [[p]] = await db.query<any[]>("SELECT method, provider, amount, status, paid_at FROM payments WHERE order_id = ?", [o.id]);
    expect(p).toMatchObject({ method: "qris", provider: "manual", amount: 30000, status: "paid" });
    expect(p.paid_at).not.toBeNull();
    const [[n]] = await db.query<any[]>("SELECT title FROM notifications WHERE JSON_EXTRACT(data, '$.order_code') = ? ORDER BY id DESC", [code]);
    expect(n).toBeDefined();
    expect((await aksi(code, "pay").expect(409)).body.error.message).toBe("Pesanan sudah berubah status.");
  });

  test("COD tidak bisa di-pay; toko lain 404; pembeli tidak punya rute ini", async () => {
    const cod = await pesanDulu(s.tCust, s.menu2);
    expect((await aksi(cod, "pay").expect(409)).body.error.message).toBe("Pesanan ini tidak menunggu pembayaran QRIS.");
    const qris = (await pesanQris().expect(201)).body.data.code;
    await aksi(qris, "pay", s.tB).expect(404);
    await aksi(qris, "pay", s.tCust).expect(403);
    expect((await pesanan(qris)).payment_status).toBe("unpaid");
  });

  test("holding lewat waktu tidak bisa di-pay", async () => {
    const code = (await pesanQris().expect(201)).body.data.code;
    await db.query("UPDATE orders SET hold_until = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 SECOND) WHERE code = ?", [code]);
    expect((await aksi(code, "pay").expect(409)).body.error.message).toBe("Batas waktu pesanan sudah habis.");
  });
});
