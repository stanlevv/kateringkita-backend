import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { menuRow, createCustomer, placeOrder, prepareCheckout } from "./helpers/merchant";

// GET /me/orders 3 tab, POST /orders/:code/cancel & /complete
let setup: Awaited<ReturnType<typeof prepareCheckout>>;
let otherToken: string;
const codes: Record<string, string> = {};

const LIST_KEYS = [
  "can_cancel",
  "can_complete",
  "can_review",
  "cancel_reason",
  "cancelled_by",
  "chat",
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
  "timeline",
  "total",
  "updated_at",
];
const listOrders = (query = "", token = setup.customerToken) =>
  request(app).get(`/api/v1/me/orders${query}`).set("Authorization", `Bearer ${token}`);
const postAction = (code: string, action: "cancel" | "complete", body?: unknown, token = setup.customerToken) => {
  const req = request(app).post(`/api/v1/orders/${code}/${action}`).set("Authorization", `Bearer ${token}`);
  return body === undefined ? req : req.send(body as object);
};
const status = async (code: string) =>
  ((await db.query<any[]>("SELECT status FROM orders WHERE code = ?", [code]))[0] as any[])[0].status;
const updateOrder = (code: string, fields: Record<string, unknown>) =>
  db.query("UPDATE orders SET ? WHERE code = ?", [fields, code]);
// pesanan berstatus tertentu, created_at berurutan per detik agar urutan pasti
let seconds = 0;
const createOrderWithStatus = async (orderStatus: string, menu = setup.menu) => {
  const code = await placeOrder(setup.customerToken, menu, 1);
  await updateOrder(code, { status: orderStatus, created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, ++seconds)) });
  return code;
};
const orderCodes = (res: request.Response) => res.body.data.map((order: { code: string }) => order.code);

beforeAll(async () => {
  setup = await prepareCheckout();
  otherToken = await createCustomer(1);
  codes.holding = await createOrderWithStatus("holding");
  codes.cooking = await createOrderWithStatus("cooking", setup.menu2);
  codes.completed = await createOrderWithStatus("completed");
  codes.cancelled = await createOrderWithStatus("cancelled");
  codes.expired = await createOrderWithStatus("expired");
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("GET /me/orders", () => {
  test("tab active (bawaan) urut terbaru, meta, bentuk Order tanpa payment/hpp", async () => {
    const res = await listOrders("?tab=active").expect(200);
    expect(orderCodes(res)).toEqual([codes.cooking, codes.holding]);
    expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 2 });
    expect(Object.keys(res.body.data[0]).sort()).toEqual(LIST_KEYS);
    expect(JSON.stringify(res.body)).not.toContain('"hpp"');
    expect(res.body.data[0]).toMatchObject({
      status: "cooking",
      hold_until: null,
      seconds_left: null,
      can_cancel: false,
    });
    expect(res.body.data[1]).toMatchObject({ status: "holding", can_cancel: true });
    expect(res.body.data[1].seconds_left).toBeGreaterThan(0);
    expect(orderCodes(await listOrders().expect(200))).toEqual([codes.cooking, codes.holding]);
  });

  test("tab completed & cancelled", async () => {
    const completedRes = await listOrders("?tab=completed").expect(200);
    expect(orderCodes(completedRes)).toEqual([codes.completed]);
    expect(completedRes.body.data[0]).toMatchObject({ can_review: true, can_cancel: false });
    expect(orderCodes(await listOrders("?tab=cancelled").expect(200))).toEqual([codes.expired, codes.cancelled]);
  });

  test("q: kode sebagian huruf kecil, nama menu, % di-escape", async () => {
    expect(orderCodes(await listOrders(`?tab=active&q=${codes.holding.slice(-6).toLowerCase()}`).expect(200))).toEqual([
      codes.holding,
    ]);
    expect(orderCodes(await listOrders("?tab=active&q=teh").expect(200))).toEqual([codes.cooking]);
    expect(orderCodes(await listOrders("?tab=active&q=nasi").expect(200))).toEqual([codes.holding]);
    expect((await listOrders("?tab=active&q=%25").expect(200)).body.data).toEqual([]);
  });

  test("page/limit", async () => {
    const res = await listOrders("?tab=cancelled&page=2&limit=1").expect(200);
    expect(orderCodes(res)).toEqual([codes.cancelled]);
    expect(res.body.meta).toEqual({ page: 2, limit: 1, total: 2 });
  });

  test("validasi query → 400 dengan fields", async () => {
    const fieldsOf = async (query: string) => (await listOrders(query).expect(400)).body.error.fields;
    expect(await fieldsOf("?tab=semua")).toEqual({ tab: ["Tab tidak dikenal."] });
    expect(await fieldsOf("?updated_since=kemarin")).toEqual({ updated_since: ["Waktu tidak valid."] });
    expect(await fieldsOf(`?q=${"a".repeat(51)}`)).toEqual({ q: ["Pencarian maksimal 50 karakter."] });
    expect(await fieldsOf("?page=0")).toEqual({ page: ["Halaman tidak valid."] });
    expect(await fieldsOf("?limit=101")).toEqual({ limit: ["Halaman tidak valid."] });
  });

  test("pembeli lain → kosong, tidak bisa cancel/complete pesanan Budi (404)", async () => {
    expect((await listOrders("?tab=active", otherToken).expect(200)).body.data).toEqual([]);
    await postAction(codes.holding, "cancel", {}, otherToken).expect(404);
    const ready = await createOrderWithStatus("ready");
    expect((await postAction(ready, "complete", {}, otherToken).expect(404)).body.error.message).toBe(
      "Pesanan tidak ditemukan.",
    );
    expect(await status(codes.holding)).toBe("holding");
    expect(await status(ready)).toBe("ready");
  });

  test("updated_since: tab diabaikan, masa depan → kosong", async () => {
    const ready = await createOrderWithStatus("ready");
    // semua pesanan lama dianggap lebih tua agar hanya perubahan baru yang terkirim
    await db.query("UPDATE orders SET updated_at = UTC_TIMESTAMP() - INTERVAL 1 HOUR");
    const [[latest]] = await db.query<any[]>("SELECT MAX(updated_at) AS t FROM orders");
    const since = new Date(latest.t.getTime() + 1000).toISOString();
    await postAction(ready, "complete").expect(200);
    const res = await listOrders(`?tab=active&updated_since=${encodeURIComponent(since)}`).expect(200);
    expect(res.body.data.map((order: any) => [order.code, order.status])).toEqual([[ready, "completed"]]);
    expect((await listOrders("?updated_since=2999-01-01T00:00:00%2B07:00").expect(200)).body.data).toEqual([]);
  });
});

describe("timeline langkah pesanan", () => {
  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const merchantAction = (code: string, action: string) =>
    request(app).post(`/api/v1/merchant/orders/${code}/${action}`).set("Authorization", `Bearer ${setup.tokenA}`);

  test("GET /orders/:code timeline berisi jam setiap langkah", async () => {
    const code = await placeOrder(setup.customerToken, setup.menu, 1);
    for (const action of ["confirm", "cook", "ready"]) await merchantAction(code, action).expect(200);
    const detail = await request(app)
      .get(`/api/v1/orders/${code}`)
      .set("Authorization", `Bearer ${setup.customerToken}`)
      .expect(200);
    const { timeline } = detail.body.data;
    expect(Object.keys(timeline).sort()).toEqual([
      "cancelled_at",
      "completed_at",
      "confirmed_at",
      "cooking_at",
      "ready_at",
    ]);
    for (const key of ["confirmed_at", "cooking_at", "ready_at"]) expect(timeline[key]).toMatch(ISO);
    expect(timeline.completed_at).toBeNull();
    expect(timeline.cancelled_at).toBeNull();
    // item di daftar pesanan membawa timeline yang sama
    const listed = (await listOrders("?tab=active").expect(200)).body.data.find((order: any) => order.code === code);
    expect(listed.timeline).toEqual(timeline);
  });

  test("completed_at terisi setelah selesai, cancelled_at terisi setelah batal", async () => {
    const getTimeline = async (code: string) =>
      (
        await request(app)
          .get(`/api/v1/orders/${code}`)
          .set("Authorization", `Bearer ${setup.customerToken}`)
          .expect(200)
      ).body.data.timeline;
    const completed = await placeOrder(setup.customerToken, setup.menu, 1);
    for (const action of ["confirm", "cook", "ready"]) await merchantAction(completed, action).expect(200);
    await postAction(completed, "complete").expect(200);
    const completedTimeline = await getTimeline(completed);
    expect(completedTimeline.completed_at).toMatch(ISO);
    expect(completedTimeline.cancelled_at).toBeNull();

    const cancelled = await placeOrder(setup.customerToken, setup.menu, 1);
    await postAction(cancelled, "cancel", { reason: "Salah pesan" }).expect(200);
    const cancelledTimeline = await getTimeline(cancelled);
    expect(cancelledTimeline.cancelled_at).toMatch(ISO);
    expect(cancelledTimeline.completed_at).toBeNull();
    expect(cancelledTimeline.confirmed_at).toBeNull();
  });
});

describe("POST /orders/:code/cancel", () => {
  test("dari holding → 200, stok kembali; ulangi → 409", async () => {
    const code = await placeOrder(setup.customerToken, setup.menu, 2);
    const held = (await menuRow(setup.menu)).held_today;
    const res = await postAction(code, "cancel", { reason: "Salah pesan" }).expect(200);
    expect(res.body.data).toMatchObject({
      code,
      status: "cancelled",
      can_cancel: false,
      hold_until: null,
      payment: { method: "cod" },
    });
    expect((await menuRow(setup.menu)).held_today).toBe(held - 2);
    expect((await postAction(code, "cancel").expect(409)).body.error).toMatchObject({
      code: "CONFLICT",
      message: "Pesanan sudah berubah status.",
    });
  });

  test("dari confirmed tunai → 200 tanpa body; cooking → 409; lewat waktu → 409 habis", async () => {
    const firstCode = await placeOrder(setup.customerToken, setup.menu);
    await updateOrder(firstCode, { status: "confirmed" });
    await postAction(firstCode, "cancel").expect(200);
    const secondCode = await createOrderWithStatus("cooking");
    await postAction(secondCode, "cancel", {}).expect(409);
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
    expect((await postAction(thirdCode, "cancel", {}).expect(409)).body.error.message).toBe(
      "Batas waktu pesanan sudah habis.",
    );
    await updateOrder(thirdCode, { status: "expired" });
  });

  test("reason > 255 → 400 fields.reason", async () => {
    const code = await placeOrder(setup.customerToken, setup.menu);
    const res = await postAction(code, "cancel", { reason: "a".repeat(256) }).expect(400);
    expect(res.body.error.fields).toEqual({ reason: ["Alasan maksimal 255 karakter."] });
    await postAction(code, "cancel", "bukan objek").expect(200);
  });
});

describe("POST /orders/:code/complete", () => {
  test("dari ready → 200 paid, can_review; dari cooking → 409", async () => {
    const code = await createOrderWithStatus("ready");
    const res = await postAction(code, "complete").expect(200);
    expect(res.body.data).toMatchObject({
      status: "completed",
      payment: { status: "paid" },
      can_review: true,
      can_complete: false,
    });
    await postAction(await createOrderWithStatus("cooking"), "complete").expect(409);
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

describe("checkout & batal pembeli yang sama berbarengan", () => {
  test.each([1, 2, 3])("putaran %i: keduanya sukses (tanpa deadlock)", async () => {
    const code = await placeOrder(setup.customerToken, setup.menu);
    const [cancelRes, orderRes] = await Promise.all([
      postAction(code, "cancel"),
      request(app)
        .post("/api/v1/orders")
        .set("Authorization", `Bearer ${setup.customerToken}`)
        .set("Idempotency-Key", randomUUID())
        .send({ items: [{ menu_id: setup.menu, qty: 1 }], pickup_point_id: 1, payment_method: "cod" }),
    ]);
    expect([cancelRes.status, orderRes.status]).toEqual([200, 201]);
    await updateOrder(orderRes.body.data.code, { status: "expired" });
  });
});

describe("review", () => {
  test("updated_since: urut updated_at naik, halaman berikutnya dari tanda air tidak melompat", async () => {
    const [firstCode, secondCode, thirdCode] = [
      await createOrderWithStatus("cooking"),
      await createOrderWithStatus("cooking"),
      await createOrderWithStatus("cooking"),
    ];
    const startMs = Date.now() - 3600e3;
    await db.query("UPDATE orders SET updated_at = ?", [new Date(startMs - 3600e3)]);
    for (const [i, code] of [firstCode, secondCode, thirdCode].entries())
      await updateOrder(code, { updated_at: new Date(startMs + [3, 1, 2][i] * 1000) });
    const res1 = await listOrders(`?updated_since=${new Date(startMs).toISOString()}&limit=2`).expect(200);
    expect(res1.body.data.map((order: any) => order.code)).toEqual([secondCode, thirdCode]);
    const res2 = await listOrders(`?updated_since=${res1.body.data.at(-1).updated_at}&limit=2`).expect(200);
    expect(res2.body.data.map((order: any) => order.code)).toEqual([thirdCode, firstCode]);
    for (const code of [firstCode, secondCode, thirdCode]) await updateOrder(code, { status: "completed" });
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
    const listed = (await listOrders("?tab=cancelled").expect(200)).body.data.find((order: any) => order.code === code);
    expect(listed).toMatchObject({ cancel_reason: "Stok habis", cancelled_by: "merchant" });
  });

  // TiDB memakai utf8mb4_bin secara bawaan (test terakhir: mengubah skema file ini)
  test("q tak peka huruf walau kolom berkolasi biner", async () => {
    await db.query("ALTER TABLE order_items MODIFY menu_name VARCHAR(80) NOT NULL COLLATE utf8mb4_bin");
    await db.query("ALTER TABLE orders MODIFY code VARCHAR(20) NOT NULL COLLATE utf8mb4_bin");
    expect(orderCodes(await listOrders("?tab=active&q=NASI").expect(200))).toContain(codes.holding);
    expect(orderCodes(await listOrders(`?tab=active&q=${codes.holding.toLowerCase()}`).expect(200))).toEqual([
      codes.holding,
    ]);
  });
});
