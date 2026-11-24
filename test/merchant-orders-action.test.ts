import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { getWibDate } from "../src/services/merchant-quota.service";
import { menuRow, placeOrder, prepareCheckout } from "./helpers/merchant";

// POST /merchant/orders/:code/:aksi + balapan antar aksi
let setup: Awaited<ReturnType<typeof prepareCheckout>>;

const postAction = (code: string, action: string, body?: unknown, token = setup.tokenA) => {
  const req = request(app).post(`/api/v1/merchant/orders/${code}/${action}`).set("Authorization", `Bearer ${token}`);
  return body === undefined ? req : req.send(body as object);
};
const cancelOrder = (code: string) =>
  request(app).post(`/api/v1/orders/${code}/cancel`).set("Authorization", `Bearer ${setup.customerToken}`);
const status = async (code: string) =>
  ((await db.query<any[]>("SELECT status FROM orders WHERE code = ?", [code]))[0] as any[])[0].status;
const log = async (code: string) =>
  (
    (
      await db.query<any[]>(
        "SELECT l.from_status, l.to_status FROM order_status_logs l JOIN orders o ON o.id = l.order_id WHERE o.code = ? ORDER BY l.id",
        [code],
      )
    )[0] as any[]
  ).map((row) => `${row.from_status}→${row.to_status}`);
const getStock = async () => {
  const menu = await menuRow(setup.menu);
  return { held: menu.held_today, sold: menu.sold_today };
};

beforeAll(async () => {
  setup = await prepareCheckout();
});
afterEach(async () => {
  await db.query("UPDATE orders SET status = 'expired' WHERE status = 'holding'");
  await db.query("UPDATE menus SET held_today = 0, sold_today = 0, sold_total = 0, stock_date = ?", [getWibDate()]);
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("alur & transisi", () => {
  test("confirm → cook → ready → complete: 200, *_at terisi, paid, 5 log, stok terjual", async () => {
    const code = await placeOrder(setup.customerToken, setup.menu, 2);
    for (const [action, expectedStatus, column] of [
      ["confirm", "confirmed", "confirmed_at"],
      ["cook", "cooking", "cooking_at"],
      ["ready", "ready", "ready_at"],
      ["complete", "completed", "completed_at"],
    ] as const) {
      const res = await postAction(code, action).expect(200);
      expect(res.body.data).toMatchObject({ code, status: expectedStatus, customer_name: "Budi" });
      expect(res.body.data[column]).not.toBeNull();
    }
    expect((await postAction(code, "cook").expect(409)).body.error.message).toBe("Pesanan sudah berubah status.");
    expect(
      (await request(app).get(`/api/v1/merchant/orders/${code}`).set("Authorization", `Bearer ${setup.tokenA}`)).body
        .data.payment_status,
    ).toBe("paid");
    expect(await log(code)).toEqual([
      "null→holding",
      "holding→confirmed",
      "confirmed→cooking",
      "cooking→ready",
      "ready→completed",
    ]);
    expect(await getStock()).toEqual({ held: 0, sold: 2 });
  });

  test("cook dari holding → 409; confirm diulang → 409; aksi tak dikenal → 404", async () => {
    const code = await placeOrder(setup.customerToken, setup.menu);
    await postAction(code, "cook").expect(409);
    await postAction(code, "confirm").expect(200);
    expect((await postAction(code, "confirm").expect(409)).body.error).toMatchObject({
      code: "CONFLICT",
      message: "Pesanan sudah berubah status.",
    });
    await postAction(code, "cancel").expect(404);
    await postAction(code, "expire").expect(404);
  });
});

describe("body diabaikan selain reject (review)", () => {
  test("confirm dengan reason > 255 → 200", async () => {
    const code = await placeOrder(setup.customerToken, setup.menu);
    await postAction(code, "confirm", { reason: "a".repeat(256) }).expect(200);
  });
});

describe("reject", () => {
  test("tanpa alasan / spasi → 400, status tetap", async () => {
    const code = await placeOrder(setup.customerToken, setup.menu);
    for (const body of [undefined, {}, { reason: "  " }]) {
      const res = await postAction(code, "reject", body).expect(400);
      expect(res.body.error).toMatchObject({
        code: "VALIDATION_ERROR",
        fields: { reason: ["Pilih alasan penolakan."] },
      });
    }
    expect((await postAction(code, "reject", { reason: "a".repeat(256) }).expect(400)).body.error.fields).toEqual({
      reason: ["Alasan maksimal 255 karakter."],
    });
    expect(await status(code)).toBe("holding");
  });

  test("dari holding → 200 cancelled_by merchant; dari confirmed → sold kembali; dari cooking → 409", async () => {
    const firstCode = await placeOrder(setup.customerToken, setup.menu, 2);
    const res = await postAction(firstCode, "reject", { reason: "Stok habis" }).expect(200);
    expect(res.body.data).toMatchObject({ status: "cancelled", cancelled_by: "merchant", cancel_reason: "Stok habis" });
    expect(res.body.data.cancelled_at).not.toBeNull();
    expect(await getStock()).toEqual({ held: 0, sold: 0 });

    const secondCode = await placeOrder(setup.customerToken, setup.menu, 2);
    await postAction(secondCode, "confirm").expect(200);
    expect(await getStock()).toEqual({ held: 0, sold: 2 });
    await postAction(secondCode, "reject", { reason: "Tutup" }).expect(200);
    expect(await getStock()).toEqual({ held: 0, sold: 0 });

    const thirdCode = await placeOrder(setup.customerToken, setup.menu);
    await db.query("UPDATE orders SET status = 'cooking' WHERE code = ?", [thirdCode]);
    await postAction(thirdCode, "reject", { reason: "Tutup" }).expect(409);
  });
});

describe("kepemilikan", () => {
  test("toko B → 404 semua aksi, status tetap; pembeli → 403", async () => {
    const code = await placeOrder(setup.customerToken, setup.menu);
    for (const action of ["confirm", "cook", "ready", "complete", "reject"]) {
      expect((await postAction(code, action, { reason: "x" }, setup.tokenB).expect(404)).body.error.message).toBe(
        "Pesanan tidak ditemukan.",
      );
    }
    await postAction(code, "confirm", undefined, setup.customerToken).expect(403);
    expect(await status(code)).toBe("holding");
  });
});

describe("balapan", () => {
  // Pesanan online lunas: tunai yang sudah dikonfirmasi masih boleh dibatalkan pembeli, jadi pada tunai keduanya bisa 200
  // secara berurutan. Online lunas membuat kedua urutan saling meniadakan → tepat satu 200.
  test.each([1, 2, 3])("putaran %i: konfirmasi penjual vs batal pembeli → tepat satu 200", async () => {
    const code = await placeOrder(setup.customerToken, setup.menu, 2);
    await db.query("UPDATE orders SET payment_method = 'online', payment_status = 'paid' WHERE code = ?", [code]);
    const [confirmRes, cancelRes] = await Promise.all([postAction(code, "confirm"), cancelOrder(code)]);
    expect([confirmRes.status, cancelRes.status].sort()).toEqual([200, 409]);
    expect(await getStock()).toEqual(confirmRes.status === 200 ? { held: 0, sold: 2 } : { held: 0, sold: 0 });
    expect(await log(code)).toHaveLength(2);
  });

  test.each([1, 2, 3])("putaran %i: tiga konfirmasi paralel → satu 200, stok sekali", async () => {
    const code = await placeOrder(setup.customerToken, setup.menu, 2);
    const responses = await Promise.all([
      postAction(code, "confirm"),
      postAction(code, "confirm"),
      postAction(code, "confirm"),
    ]);
    expect(responses.map((item) => item.status).sort()).toEqual([200, 409, 409]);
    expect(await getStock()).toEqual({ held: 0, sold: 2 });
    expect(await log(code)).toHaveLength(2);
  });
});
