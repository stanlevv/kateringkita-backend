import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { menuRow, pembeliBaru, siapCheckout, sisipMenu } from "./helpers/toko";

// F13: POST /orders/:code/reviews + GET /merchant/reviews + rating menu/toko + can_review
let s: Awaited<ReturnType<typeof siapCheckout>>;
let kode: string;
const H = (t: string) => ({ Authorization: `Bearer ${t}` });
const ulas = (items: object[], code = kode, t = s.tCust) => request(app).post(`/api/v1/orders/${code}/reviews`).set(H(t)).send({ items });
const detail = async () => (await request(app).get(`/api/v1/orders/${kode}`).set(H(s.tCust)).expect(200)).body.data;

beforeAll(async () => {
  s = await siapCheckout();
  const r = await request(app).post("/api/v1/orders").set(H(s.tCust)).set("Idempotency-Key", randomUUID())
    .send({ items: [{ menu_id: s.menu, qty: 1 }, { menu_id: s.menu2, qty: 1 }], pickup_point_id: 1, payment_method: "cod" }).expect(201);
  kode = r.body.data.code;
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("kirim ulasan", () => {
  test("pesanan belum selesai → 409, can_review false", async () => {
    expect((await ulas([{ menu_id: s.menu, rating: 5 }]).expect(409)).body.error.message).toBe("Ulasan hanya bisa untuk pesanan yang sudah selesai.");
    expect((await detail()).can_review).toBe(false);
    for (const a of ["confirm", "cook", "ready", "complete"]) {
      await request(app).post(`/api/v1/merchant/orders/${kode}/${a}`).set(H(s.tA)).expect(200);
    }
    expect((await detail()).can_review).toBe(true);
  });

  test("validasi rating, menu di luar pesanan, pesanan orang lain", async () => {
    expect((await ulas([{ menu_id: s.menu, rating: 6 }]).expect(400)).body.error.fields).toEqual({ "items.0.rating": ["Rating harus 1–5."] });
    const lain = await sisipMenu(s.idA, { name: "Lain" });
    expect((await ulas([{ menu_id: lain, rating: 5 }]).expect(409)).body.error.fields)
      .toEqual({ "items.0.menu_id": ["Menu tidak ada di pesanan ini."] });
    await ulas([{ menu_id: s.menu, rating: 5 }], kode, await pembeliBaru(1)).expect(404);
  });

  test("ulasan menghitung rating menu & toko; can_review mati setelah semua diulas; ganda ditolak", async () => {
    expect((await ulas([{ menu_id: s.menu, rating: 4, comment: "  Enak  " }]).expect(201)).body.data)
      .toEqual({ order_code: kode, reviewed_menu_ids: [s.menu] });
    expect(await menuRow(s.menu)).toMatchObject({ rating_avg: "4.00", rating_count: 1 });
    expect((await detail()).can_review).toBe(true);
    await ulas([{ menu_id: s.menu2, rating: 2 }]).expect(201);
    const [[m]] = await db.query<any[]>("SELECT rating_avg, rating_count FROM merchants WHERE id = ?", [s.idA]);
    expect(m).toEqual({ rating_avg: "3.00", rating_count: 2 });
    expect((await detail()).can_review).toBe(false);
    expect((await ulas([{ menu_id: s.menu, rating: 1 }]).expect(409)).body.error.fields).toEqual({ "items.0.menu_id": ["Menu ini sudah diulas."] });
    const [[r]] = await db.query<any[]>("SELECT comment FROM reviews WHERE menu_id = ?", [s.menu]);
    expect(r.comment).toBe("Enak");
  });
});

describe("GET /merchant/reviews", () => {
  test("ulasan toko sendiri, terbaru dulu, sesuai tipe Review fe", async () => {
    const r = await request(app).get("/api/v1/merchant/reviews").set(H(s.tA)).expect(200);
    expect(r.body.data).toHaveLength(2);
    expect(r.body.data.find((x: { menu_id: number }) => x.menu_id === s.menu))
      .toMatchObject({ menu_name: "Nasi Ayam", customer_name: "Budi", rating: 4, comment: "Enak" });
    expect(Object.keys(r.body.data[0]).sort()).toEqual(["comment", "created_at", "customer_name", "id", "menu_id", "menu_name", "rating"]);
    expect((await request(app).get("/api/v1/merchant/reviews").set(H(s.tB)).expect(200)).body.data).toEqual([]);
  });
});
