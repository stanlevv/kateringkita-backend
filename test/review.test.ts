import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { menuRow, createCustomer, prepareCheckout, insertMenu } from "./helpers/merchant";

// Ulasan: POST /orders/:code/reviews + GET /merchant/reviews + rating menu/toko + can_review
let setup: Awaited<ReturnType<typeof prepareCheckout>>;
let orderCode: string;
const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });
const postReview = (items: object[], code = orderCode, token = setup.customerToken) =>
  request(app).post(`/api/v1/orders/${code}/reviews`).set(authHeader(token)).send({ items });
const detail = async () =>
  (await request(app).get(`/api/v1/orders/${orderCode}`).set(authHeader(setup.customerToken)).expect(200)).body.data;

beforeAll(async () => {
  setup = await prepareCheckout();
  const res = await request(app)
    .post("/api/v1/orders")
    .set(authHeader(setup.customerToken))
    .set("Idempotency-Key", randomUUID())
    .send({
      items: [
        { menu_id: setup.menu, qty: 1 },
        { menu_id: setup.menu2, qty: 1 },
      ],
      pickup_point_id: 1,
      payment_method: "cod",
    })
    .expect(201);
  orderCode = res.body.data.code;
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("kirim ulasan", () => {
  test("pesanan belum selesai → 409, can_review false", async () => {
    expect((await postReview([{ menu_id: setup.menu, rating: 5 }]).expect(409)).body.error.message).toBe(
      "Ulasan hanya bisa untuk pesanan yang sudah selesai.",
    );
    expect((await detail()).can_review).toBe(false);
    for (const action of ["confirm", "cook", "ready", "complete"]) {
      await request(app)
        .post(`/api/v1/merchant/orders/${orderCode}/${action}`)
        .set(authHeader(setup.tokenA))
        .expect(200);
    }
    expect((await detail()).can_review).toBe(true);
  });

  test("validasi rating, menu di luar pesanan, pesanan orang lain", async () => {
    expect((await postReview([{ menu_id: setup.menu, rating: 6 }]).expect(400)).body.error.fields).toEqual({
      "items.0.rating": ["Rating harus 1–5."],
    });
    const otherMenu = await insertMenu(setup.idA, { name: "Lain" });
    expect((await postReview([{ menu_id: otherMenu, rating: 5 }]).expect(409)).body.error.fields).toEqual({
      "items.0.menu_id": ["Menu tidak ada di pesanan ini."],
    });
    await postReview([{ menu_id: setup.menu, rating: 5 }], orderCode, await createCustomer(1)).expect(404);
  });

  test("ulasan menghitung rating menu & toko; can_review mati setelah semua diulas; ganda ditolak", async () => {
    expect((await postReview([{ menu_id: setup.menu, rating: 4, comment: "  Enak  " }]).expect(201)).body.data).toEqual(
      {
        order_code: orderCode,
        reviewed_menu_ids: [setup.menu],
      },
    );
    expect(await menuRow(setup.menu)).toMatchObject({ rating_avg: "4.00", rating_count: 1 });
    expect((await detail()).can_review).toBe(true);
    await postReview([{ menu_id: setup.menu2, rating: 2 }]).expect(201);
    const [[merchant]] = await db.query<any[]>("SELECT rating_avg, rating_count FROM merchants WHERE id = ?", [
      setup.idA,
    ]);
    expect(merchant).toEqual({ rating_avg: "3.00", rating_count: 2 });
    expect((await detail()).can_review).toBe(false);
    expect((await postReview([{ menu_id: setup.menu, rating: 1 }]).expect(409)).body.error.fields).toEqual({
      "items.0.menu_id": ["Menu ini sudah diulas."],
    });
    const [[review]] = await db.query<any[]>("SELECT comment FROM reviews WHERE menu_id = ?", [setup.menu]);
    expect(review.comment).toBe("Enak");
  });
});

describe("GET /merchant/reviews", () => {
  test("ulasan toko sendiri, terbaru dulu, sesuai tipe Review fe", async () => {
    const res = await request(app).get("/api/v1/merchant/reviews").set(authHeader(setup.tokenA)).expect(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.find((review: { menu_id: number }) => review.menu_id === setup.menu)).toMatchObject({
      menu_name: "Nasi Ayam",
      customer_name: "Budi",
      rating: 4,
      comment: "Enak",
    });
    expect(Object.keys(res.body.data[0]).sort()).toEqual([
      "comment",
      "created_at",
      "customer_name",
      "id",
      "menu_id",
      "menu_name",
      "rating",
    ]);
    expect(
      (await request(app).get("/api/v1/merchant/reviews").set(authHeader(setup.tokenB)).expect(200)).body.data,
    ).toEqual([]);
  });
});
