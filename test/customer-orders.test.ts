import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { menuRow, createCustomer, placeOrder, prepareCheckout } from "./helpers/merchant";

// F07 Task 2: GET /me/orders 3 tab, POST /orders/:code/cancel & /complete (C-14, C-15, C-16, R-10, R-11; D2, D8–D11, D13)
let setup: Awaited<ReturnType<typeof prepareCheckout>>;
let tLain: string;
const codes: Record<string, string> = {};

const KUNCI_DAFTAR = [
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
const daftar = (query = "", token = setup.customerToken) =>
  request(app).get(`/api/v1/me/orders${query}`).set("Authorization", `Bearer ${token}`);
const aksi = (code: string, action: "cancel" | "complete", body?: unknown, token = setup.customerToken) => {
  const req = request(app).post(`/api/v1/orders/${code}/${action}`).set("Authorization", `Bearer ${token}`);
  return body === undefined ? req : req.send(body as object);
};
const status = async (code: string) =>
  ((await db.query<any[]>("SELECT status FROM orders WHERE code = ?", [code]))[0] as any[])[0].status;
const atur = (code: string, fields: Record<string, unknown>) =>
  db.query("UPDATE orders SET ? WHERE code = ?", [fields, code]);
// pesanan berstatus tertentu, created_at berurutan per detik agar urutan pasti
let detik = 0;
const buat = async (orderStatus: string, menu = setup.menu) => {
  const code = await placeOrder(setup.customerToken, menu, 1);
  await atur(code, { status: orderStatus, created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, ++detik)) });
  return code;
};
const kodeDari = (res: request.Response) => res.body.data.map((order: { code: string }) => order.code);

beforeAll(async () => {
  setup = await prepareCheckout();
  tLain = await createCustomer(1);
  codes.holding = await buat("holding");
  codes.cooking = await buat("cooking", setup.menu2);
  codes.completed = await buat("completed");
  codes.cancelled = await buat("cancelled");
  codes.expired = await buat("expired");
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("GET /me/orders", () => {
  test("tab active (bawaan) urut terbaru, meta, bentuk Order tanpa payment/hpp", async () => {
    const res = await daftar("?tab=active").expect(200);
    expect(kodeDari(res)).toEqual([codes.cooking, codes.holding]);
    expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 2 });
    expect(Object.keys(res.body.data[0]).sort()).toEqual(KUNCI_DAFTAR);
    expect(JSON.stringify(res.body)).not.toContain('"hpp"');
    expect(res.body.data[0]).toMatchObject({
      status: "cooking",
      hold_until: null,
      seconds_left: null,
      can_cancel: false,
    });
    expect(res.body.data[1]).toMatchObject({ status: "holding", can_cancel: true });
    expect(res.body.data[1].seconds_left).toBeGreaterThan(0);
    expect(kodeDari(await daftar().expect(200))).toEqual([codes.cooking, codes.holding]);
  });

  test("tab completed & cancelled", async () => {
    const completedRes = await daftar("?tab=completed").expect(200);
    expect(kodeDari(completedRes)).toEqual([codes.completed]);
    expect(completedRes.body.data[0]).toMatchObject({ can_review: true, can_cancel: false });
    expect(kodeDari(await daftar("?tab=cancelled").expect(200))).toEqual([codes.expired, codes.cancelled]);
  });

  test("q: kode sebagian huruf kecil, nama menu, % di-escape", async () => {
    expect(kodeDari(await daftar(`?tab=active&q=${codes.holding.slice(-6).toLowerCase()}`).expect(200))).toEqual([
      codes.holding,
    ]);
    expect(kodeDari(await daftar("?tab=active&q=teh").expect(200))).toEqual([codes.cooking]);
    expect(kodeDari(await daftar("?tab=active&q=nasi").expect(200))).toEqual([codes.holding]);
    expect((await daftar("?tab=active&q=%25").expect(200)).body.data).toEqual([]);
  });

  test("page/limit", async () => {
    const res = await daftar("?tab=cancelled&page=2&limit=1").expect(200);
    expect(kodeDari(res)).toEqual([codes.cancelled]);
    expect(res.body.meta).toEqual({ page: 2, limit: 1, total: 2 });
  });

  test("validasi query → 400 dengan fields", async () => {
    const fieldsOf = async (query: string) => (await daftar(query).expect(400)).body.error.fields;
    expect(await fieldsOf("?tab=semua")).toEqual({ tab: ["Tab tidak dikenal."] });
    expect(await fieldsOf("?updated_since=kemarin")).toEqual({ updated_since: ["Waktu tidak valid."] });
    expect(await fieldsOf(`?q=${"a".repeat(51)}`)).toEqual({ q: ["Pencarian maksimal 50 karakter."] });
    expect(await fieldsOf("?page=0")).toEqual({ page: ["Halaman tidak valid."] });
    expect(await fieldsOf("?limit=101")).toEqual({ limit: ["Halaman tidak valid."] });
  });

  test("pembeli lain → kosong, tidak bisa cancel/complete pesanan Budi (404)", async () => {
    expect((await daftar("?tab=active", tLain).expect(200)).body.data).toEqual([]);
    await aksi(codes.holding, "cancel", {}, tLain).expect(404);
    const ready = await buat("ready");
    expect((await aksi(ready, "complete", {}, tLain).expect(404)).body.error.message).toBe("Pesanan tidak ditemukan.");
    expect(await status(codes.holding)).toBe("holding");
    expect(await status(ready)).toBe("ready");
  });

  test("updated_since: tab diabaikan, masa depan → kosong", async () => {
    const ready = await buat("ready");
    // semua pesanan lama dianggap lebih tua agar hanya perubahan baru yang terkirim
    await db.query("UPDATE orders SET updated_at = UTC_TIMESTAMP() - INTERVAL 1 HOUR");
    const [[latest]] = await db.query<any[]>("SELECT MAX(updated_at) AS t FROM orders");
    const since = new Date(latest.t.getTime() + 1000).toISOString();
    await aksi(ready, "complete").expect(200);
    const res = await daftar(`?tab=active&updated_since=${encodeURIComponent(since)}`).expect(200);
    expect(res.body.data.map((order: any) => [order.code, order.status])).toEqual([[ready, "completed"]]);
    expect((await daftar("?updated_since=2999-01-01T00:00:00%2B07:00").expect(200)).body.data).toEqual([]);
  });
});

describe("POST /orders/:code/cancel", () => {
  test("dari holding → 200, stok kembali; ulangi → 409", async () => {
    const code = await placeOrder(setup.customerToken, setup.menu, 2);
    const held = (await menuRow(setup.menu)).held_today;
    const res = await aksi(code, "cancel", { reason: "Salah pesan" }).expect(200);
    expect(res.body.data).toMatchObject({
      code,
      status: "cancelled",
      can_cancel: false,
      hold_until: null,
      payment: { method: "cod" },
    });
    expect((await menuRow(setup.menu)).held_today).toBe(held - 2);
    expect((await aksi(code, "cancel").expect(409)).body.error).toMatchObject({
      code: "CONFLICT",
      message: "Pesanan sudah berubah status.",
    });
  });

  test("dari confirmed tunai → 200 tanpa body; cooking → 409; lewat waktu → 409 habis", async () => {
    const firstCode = await placeOrder(setup.customerToken, setup.menu);
    await atur(firstCode, { status: "confirmed" });
    await aksi(firstCode, "cancel").expect(200);
    const secondCode = await buat("cooking");
    await aksi(secondCode, "cancel", {}).expect(409);
    const thirdCode = await placeOrder(setup.customerToken, setup.menu);
    await db.query("UPDATE orders SET hold_until = UTC_TIMESTAMP() - INTERVAL 1 MINUTE WHERE code = ?", [thirdCode]);
    expect(
      (
        await request(app)
          .get(`/api/v1/orders/${thirdCode}`)
          .set("Authorization", `Bearer ${setup.customerToken}`)
          .expect(200)
      ).body.data.can_cancel,
    ).toBe(false);
    expect((await aksi(thirdCode, "cancel", {}).expect(409)).body.error.message).toBe(
      "Batas waktu pesanan sudah habis.",
    );
    await atur(thirdCode, { status: "expired" });
  });

  test("reason > 255 → 400 fields.reason", async () => {
    const code = await placeOrder(setup.customerToken, setup.menu);
    const res = await aksi(code, "cancel", { reason: "a".repeat(256) }).expect(400);
    expect(res.body.error.fields).toEqual({ reason: ["Alasan maksimal 255 karakter."] });
    await aksi(code, "cancel", "bukan objek").expect(200);
  });
});

describe("POST /orders/:code/complete", () => {
  test("dari ready → 200 paid, can_review; dari cooking → 409", async () => {
    const code = await buat("ready");
    const res = await aksi(code, "complete").expect(200);
    expect(res.body.data).toMatchObject({
      status: "completed",
      payment: { status: "paid" },
      can_review: true,
      can_complete: false,
    });
    await aksi(await buat("cooking"), "complete").expect(409);
  });
});

describe("penjaga", () => {
  test.each([
    ["get", "/api/v1/me/orders"],
    ["post", "/api/v1/orders/KK-1/cancel"],
    ["post", "/api/v1/orders/KK-1/complete"],
  ] as const)("%s %s: tanpa token 401, penjual 403", async (method, url) => {
    await request(app)[method](url).expect(401);
    await request(app)[method](url).set("Authorization", `Bearer ${setup.tokenA}`).expect(403);
  });
});

describe("D5: checkout & batal pembeli yang sama berbarengan", () => {
  test.each([1, 2, 3])("putaran %i: keduanya sukses (tanpa deadlock)", async () => {
    const code = await placeOrder(setup.customerToken, setup.menu);
    const [cancelRes, orderRes] = await Promise.all([
      aksi(code, "cancel"),
      request(app)
        .post("/api/v1/orders")
        .set("Authorization", `Bearer ${setup.customerToken}`)
        .set("Idempotency-Key", randomUUID())
        .send({ items: [{ menu_id: setup.menu, qty: 1 }], pickup_point_id: 1, payment_method: "cod" }),
    ]);
    expect([cancelRes.status, orderRes.status]).toEqual([200, 201]);
    await atur(orderRes.body.data.code, { status: "expired" });
  });
});

describe("review", () => {
  test("updated_since: urut updated_at naik, halaman berikutnya dari tanda air tidak melompat", async () => {
    const [firstCode, secondCode, thirdCode] = [await buat("cooking"), await buat("cooking"), await buat("cooking")];
    const startMs = Date.now() - 3600e3;
    await db.query("UPDATE orders SET updated_at = ?", [new Date(startMs - 3600e3)]);
    for (const [i, code] of [firstCode, secondCode, thirdCode].entries())
      await atur(code, { updated_at: new Date(startMs + [3, 1, 2][i] * 1000) });
    const res1 = await daftar(`?updated_since=${new Date(startMs).toISOString()}&limit=2`).expect(200);
    expect(res1.body.data.map((order: any) => order.code)).toEqual([secondCode, thirdCode]);
    const res2 = await daftar(`?updated_since=${res1.body.data.at(-1).updated_at}&limit=2`).expect(200);
    expect(res2.body.data.map((order: any) => order.code)).toEqual([thirdCode, firstCode]);
    for (const code of [firstCode, secondCode, thirdCode]) await atur(code, { status: "completed" });
  });

  test("Order pembeli memuat cancel_reason & cancelled_by penolakan penjual", async () => {
    const code = await placeOrder(setup.customerToken, setup.menu);
    await request(app)
      .post(`/api/v1/merchant/orders/${code}/reject`)
      .set("Authorization", `Bearer ${setup.tokenA}`)
      .send({ reason: "Stok habis" })
      .expect(200);
    const detail = (
      await request(app).get(`/api/v1/orders/${code}`).set("Authorization", `Bearer ${setup.customerToken}`).expect(200)
    ).body.data;
    expect(detail).toMatchObject({ cancel_reason: "Stok habis", cancelled_by: "merchant" });
    const listed = (await daftar("?tab=cancelled").expect(200)).body.data.find((order: any) => order.code === code);
    expect(listed).toMatchObject({ cancel_reason: "Stok habis", cancelled_by: "merchant" });
  });

  // TiDB memakai utf8mb4_bin secara bawaan (test terakhir: mengubah skema file ini)
  test("q tak peka huruf walau kolom berkolasi biner", async () => {
    await db.query("ALTER TABLE order_items MODIFY menu_name VARCHAR(80) NOT NULL COLLATE utf8mb4_bin");
    await db.query("ALTER TABLE orders MODIFY code VARCHAR(20) NOT NULL COLLATE utf8mb4_bin");
    expect(kodeDari(await daftar("?tab=active&q=NASI").expect(200))).toContain(codes.holding);
    expect(kodeDari(await daftar(`?tab=active&q=${codes.holding.toLowerCase()}`).expect(200))).toEqual([codes.holding]);
  });
});
