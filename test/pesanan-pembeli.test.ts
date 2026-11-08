import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { menuRow, pembeliBaru, pesanDulu, siapCheckout } from "./helpers/toko";

// F07 Task 2: GET /me/orders 3 tab, POST /orders/:code/cancel & /complete (C-14, C-15, C-16, R-10, R-11; D2, D8–D11, D13)
let s: Awaited<ReturnType<typeof siapCheckout>>;
let tLain: string;
const k: Record<string, string> = {};

const KUNCI_DAFTAR = [
  "can_cancel", "can_complete", "can_review", "cancel_reason", "cancelled_by", "code", "created_at", "discount", "hold_until", "items", "merchant", "note",
  "payment_method", "payment_status", "pickup_at", "pickup_point", "seconds_left", "service_fee", "status", "subtotal", "total", "updated_at",
];
const daftar = (qs = "", token = s.tCust) => request(app).get(`/api/v1/me/orders${qs}`).set("Authorization", `Bearer ${token}`);
const aksi = (code: string, a: "cancel" | "complete", body?: unknown, token = s.tCust) => {
  const r = request(app).post(`/api/v1/orders/${code}/${a}`).set("Authorization", `Bearer ${token}`);
  return body === undefined ? r : r.send(body as object);
};
const status = async (code: string) => ((await db.query<any[]>("SELECT status FROM orders WHERE code = ?", [code]))[0] as any[])[0].status;
const atur = (code: string, o: Record<string, unknown>) => db.query("UPDATE orders SET ? WHERE code = ?", [o, code]);
// pesanan berstatus tertentu, created_at berurutan per detik agar urutan pasti
let detik = 0;
const buat = async (st: string, menu = s.menu) => {
  const code = await pesanDulu(s.tCust, menu, 1);
  await atur(code, { status: st, created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, ++detik)) });
  return code;
};
const kodeDari = (r: request.Response) => r.body.data.map((o: { code: string }) => o.code);

beforeAll(async () => {
  s = await siapCheckout();
  tLain = await pembeliBaru(1);
  k.holding = await buat("holding");
  k.cooking = await buat("cooking", s.menu2);
  k.completed = await buat("completed");
  k.cancelled = await buat("cancelled");
  k.expired = await buat("expired");
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("GET /me/orders", () => {
  test("tab active (bawaan) urut terbaru, meta, bentuk Order tanpa payment/hpp", async () => {
    const r = await daftar("?tab=active").expect(200);
    expect(kodeDari(r)).toEqual([k.cooking, k.holding]);
    expect(r.body.meta).toEqual({ page: 1, limit: 20, total: 2 });
    expect(Object.keys(r.body.data[0]).sort()).toEqual(KUNCI_DAFTAR);
    expect(JSON.stringify(r.body)).not.toContain('"hpp"');
    expect(r.body.data[0]).toMatchObject({ status: "cooking", hold_until: null, seconds_left: null, can_cancel: false });
    expect(r.body.data[1]).toMatchObject({ status: "holding", can_cancel: true });
    expect(r.body.data[1].seconds_left).toBeGreaterThan(0);
    expect(kodeDari(await daftar().expect(200))).toEqual([k.cooking, k.holding]);
  });

  test("tab completed & cancelled", async () => {
    const c = await daftar("?tab=completed").expect(200);
    expect(kodeDari(c)).toEqual([k.completed]);
    expect(c.body.data[0]).toMatchObject({ can_review: true, can_cancel: false });
    expect(kodeDari(await daftar("?tab=cancelled").expect(200))).toEqual([k.expired, k.cancelled]);
  });

  test("q: kode sebagian huruf kecil, nama menu, % di-escape", async () => {
    expect(kodeDari(await daftar(`?tab=active&q=${k.holding.slice(-6).toLowerCase()}`).expect(200))).toEqual([k.holding]);
    expect(kodeDari(await daftar("?tab=active&q=teh").expect(200))).toEqual([k.cooking]);
    expect(kodeDari(await daftar("?tab=active&q=nasi").expect(200))).toEqual([k.holding]);
    expect((await daftar("?tab=active&q=%25").expect(200)).body.data).toEqual([]);
  });

  test("page/limit", async () => {
    const r = await daftar("?tab=cancelled&page=2&limit=1").expect(200);
    expect(kodeDari(r)).toEqual([k.cancelled]);
    expect(r.body.meta).toEqual({ page: 2, limit: 1, total: 2 });
  });

  test("validasi query → 400 dengan fields", async () => {
    const f = async (qs: string) => (await daftar(qs).expect(400)).body.error.fields;
    expect(await f("?tab=semua")).toEqual({ tab: ["Tab tidak dikenal."] });
    expect(await f("?updated_since=kemarin")).toEqual({ updated_since: ["Waktu tidak valid."] });
    expect(await f(`?q=${"a".repeat(51)}`)).toEqual({ q: ["Pencarian maksimal 50 karakter."] });
    expect(await f("?page=0")).toEqual({ page: ["Halaman tidak valid."] });
    expect(await f("?limit=101")).toEqual({ limit: ["Halaman tidak valid."] });
  });

  test("pembeli lain → kosong, tidak bisa cancel/complete pesanan Budi (404)", async () => {
    expect((await daftar("?tab=active", tLain).expect(200)).body.data).toEqual([]);
    await aksi(k.holding, "cancel", {}, tLain).expect(404);
    const ready = await buat("ready");
    expect((await aksi(ready, "complete", {}, tLain).expect(404)).body.error.message).toBe("Pesanan tidak ditemukan.");
    expect(await status(k.holding)).toBe("holding");
    expect(await status(ready)).toBe("ready");
  });

  test("updated_since: tab diabaikan, masa depan → kosong", async () => {
    const ready = await buat("ready");
    // semua pesanan lama dianggap lebih tua agar hanya perubahan baru yang terkirim
    await db.query("UPDATE orders SET updated_at = UTC_TIMESTAMP() - INTERVAL 1 HOUR");
    const [[m]] = await db.query<any[]>("SELECT MAX(updated_at) AS t FROM orders");
    const t = new Date(m.t.getTime() + 1000).toISOString();
    await aksi(ready, "complete").expect(200);
    const r = await daftar(`?tab=active&updated_since=${encodeURIComponent(t)}`).expect(200);
    expect(r.body.data.map((o: any) => [o.code, o.status])).toEqual([[ready, "completed"]]);
    expect((await daftar("?updated_since=2999-01-01T00:00:00%2B07:00").expect(200)).body.data).toEqual([]);
  });
});

describe("POST /orders/:code/cancel", () => {
  test("dari holding → 200, stok kembali; ulangi → 409", async () => {
    const code = await pesanDulu(s.tCust, s.menu, 2);
    const held = (await menuRow(s.menu)).held_today;
    const r = await aksi(code, "cancel", { reason: "Salah pesan" }).expect(200);
    expect(r.body.data).toMatchObject({ code, status: "cancelled", can_cancel: false, hold_until: null, payment: { method: "cod" } });
    expect((await menuRow(s.menu)).held_today).toBe(held - 2);
    expect((await aksi(code, "cancel").expect(409)).body.error).toMatchObject({ code: "CONFLICT", message: "Pesanan sudah berubah status." });
  });

  test("dari confirmed tunai → 200 tanpa body; cooking → 409; lewat waktu → 409 habis", async () => {
    const a = await pesanDulu(s.tCust, s.menu);
    await atur(a, { status: "confirmed" });
    await aksi(a, "cancel").expect(200);
    const b = await buat("cooking");
    await aksi(b, "cancel", {}).expect(409);
    const c = await pesanDulu(s.tCust, s.menu);
    await db.query("UPDATE orders SET hold_until = UTC_TIMESTAMP() - INTERVAL 1 MINUTE WHERE code = ?", [c]);
    expect((await request(app).get(`/api/v1/orders/${c}`).set("Authorization", `Bearer ${s.tCust}`).expect(200)).body.data.can_cancel)
      .toBe(false);
    expect((await aksi(c, "cancel", {}).expect(409)).body.error.message).toBe("Batas waktu pesanan sudah habis.");
    await atur(c, { status: "expired" });
  });

  test("reason > 255 → 400 fields.reason", async () => {
    const code = await pesanDulu(s.tCust, s.menu);
    const r = await aksi(code, "cancel", { reason: "a".repeat(256) }).expect(400);
    expect(r.body.error.fields).toEqual({ reason: ["Alasan maksimal 255 karakter."] });
    await aksi(code, "cancel", "bukan objek").expect(200);
  });
});

describe("POST /orders/:code/complete", () => {
  test("dari ready → 200 paid, can_review; dari cooking → 409", async () => {
    const code = await buat("ready");
    const r = await aksi(code, "complete").expect(200);
    expect(r.body.data).toMatchObject({ status: "completed", payment: { status: "paid" }, can_review: true, can_complete: false });
    await aksi(await buat("cooking"), "complete").expect(409);
  });
});

describe("penjaga", () => {
  test.each([
    ["get", "/api/v1/me/orders"], ["post", "/api/v1/orders/KK-1/cancel"], ["post", "/api/v1/orders/KK-1/complete"],
  ] as const)("%s %s: tanpa token 401, penjual 403", async (m, url) => {
    await request(app)[m](url).expect(401);
    await request(app)[m](url).set("Authorization", `Bearer ${s.tA}`).expect(403);
  });
});

describe("D5: checkout & batal pembeli yang sama berbarengan", () => {
  test.each([1, 2, 3])("putaran %i: keduanya sukses (tanpa deadlock)", async () => {
    const code = await pesanDulu(s.tCust, s.menu);
    const [c, p] = await Promise.all([
      aksi(code, "cancel"),
      request(app).post("/api/v1/orders").set("Authorization", `Bearer ${s.tCust}`).set("Idempotency-Key", randomUUID())
        .send({ items: [{ menu_id: s.menu, qty: 1 }], pickup_point_id: 1, payment_method: "cod" }),
    ]);
    expect([c.status, p.status]).toEqual([200, 201]);
    await atur(p.body.data.code, { status: "expired" });
  });
});

describe("review", () => {
  test("updated_since: urut updated_at naik, halaman berikutnya dari tanda air tidak melompat", async () => {
    const [a, b, c] = [await buat("cooking"), await buat("cooking"), await buat("cooking")];
    const t0 = Date.now() - 3600e3;
    await db.query("UPDATE orders SET updated_at = ?", [new Date(t0 - 3600e3)]);
    for (const [i, code] of [a, b, c].entries()) await atur(code, { updated_at: new Date(t0 + [3, 1, 2][i] * 1000) });
    const r1 = await daftar(`?updated_since=${new Date(t0).toISOString()}&limit=2`).expect(200);
    expect(r1.body.data.map((o: any) => o.code)).toEqual([b, c]);
    const r2 = await daftar(`?updated_since=${r1.body.data.at(-1).updated_at}&limit=2`).expect(200);
    expect(r2.body.data.map((o: any) => o.code)).toEqual([c, a]);
    for (const code of [a, b, c]) await atur(code, { status: "completed" });
  });

  test("Order pembeli memuat cancel_reason & cancelled_by penolakan penjual", async () => {
    const code = await pesanDulu(s.tCust, s.menu);
    await request(app).post(`/api/v1/merchant/orders/${code}/reject`).set("Authorization", `Bearer ${s.tA}`)
      .send({ reason: "Stok habis" }).expect(200);
    const d = (await request(app).get(`/api/v1/orders/${code}`).set("Authorization", `Bearer ${s.tCust}`).expect(200)).body.data;
    expect(d).toMatchObject({ cancel_reason: "Stok habis", cancelled_by: "merchant" });
    const l = (await daftar("?tab=cancelled").expect(200)).body.data.find((o: any) => o.code === code);
    expect(l).toMatchObject({ cancel_reason: "Stok habis", cancelled_by: "merchant" });
  });

  // TiDB memakai utf8mb4_bin secara bawaan (test terakhir: mengubah skema file ini)
  test("q tak peka huruf walau kolom berkolasi biner", async () => {
    await db.query("ALTER TABLE order_items MODIFY menu_name VARCHAR(80) NOT NULL COLLATE utf8mb4_bin");
    await db.query("ALTER TABLE orders MODIFY code VARCHAR(20) NOT NULL COLLATE utf8mb4_bin");
    expect(kodeDari(await daftar("?tab=active&q=NASI").expect(200))).toContain(k.holding);
    expect(kodeDari(await daftar(`?tab=active&q=${k.holding.toLowerCase()}`).expect(200))).toEqual([k.holding]);
  });
});
