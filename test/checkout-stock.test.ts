import { randomUUID } from "node:crypto";
import request from "supertest";
import { beforeEach, expect, test } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { withTransaction } from "../src/services/admin-audit.service";
import { releaseStock } from "../src/services/order-stock.service";
import { menuRow, prepareCheckout, insertMenu } from "./helpers/merchant";

// releaseStock: stok dikembalikan saat pesanan batal atau kedaluwarsa
let setup: Awaited<ReturnType<typeof prepareCheckout>>;

const postOrder = async (items: { menu_id: number; qty: number }[]) => {
  const res = await request(app)
    .post("/api/v1/orders")
    .set("Authorization", `Bearer ${setup.customerToken}`)
    .set("Idempotency-Key", randomUUID())
    .send({ items, pickup_point_id: 1, payment_method: "cod" })
    .expect(201);
  const [[order]] = await db.query<any[]>("SELECT id FROM orders WHERE code = ?", [res.body.data.code]);
  return order.id as number;
};
const release = (id: number, outcome: "terjual" | "kembali") =>
  withTransaction((conn) => releaseStock(conn, id, outcome));
const getStock = async (id: number) => {
  const menu = await menuRow(id);
  return { held: menu.held_today, sold: menu.sold_today, total: menu.sold_total };
};

beforeEach(async () => {
  setup = await prepareCheckout();
});

test("hari sama: kembali → held turun; terjual → held turun, sold_today & sold_total naik", async () => {
  const firstOrderId = await postOrder([{ menu_id: setup.menu, qty: 2 }]);
  expect(await getStock(setup.menu)).toEqual({ held: 2, sold: 0, total: 0 });
  await release(firstOrderId, "kembali");
  expect(await getStock(setup.menu)).toEqual({ held: 0, sold: 0, total: 0 });

  const secondOrderId = await postOrder([{ menu_id: setup.menu, qty: 2 }]);
  await release(secondOrderId, "terjual");
  expect(await getStock(setup.menu)).toEqual({ held: 0, sold: 2, total: 2 });
});

test("lintas tengah malam: penghitung harian hari baru tidak disentuh, sold_total tetap naik", async () => {
  const firstOrderId = await postOrder([{ menu_id: setup.menu, qty: 2 }]);
  const moveToNextDay = () =>
    db.query(
      "UPDATE menus SET stock_date = DATE_ADD(stock_date, INTERVAL 1 DAY), held_today = 5, sold_today = 1 WHERE id = ?",
      [setup.menu],
    );
  await moveToNextDay();
  await release(firstOrderId, "kembali");
  expect(await getStock(setup.menu)).toEqual({ held: 5, sold: 1, total: 0 });
  await release(firstOrderId, "terjual");
  expect(await getStock(setup.menu)).toEqual({ held: 5, sold: 1, total: 2 });
});

test("menu sudah dihapus (soft delete) tetap dilepas", async () => {
  const firstOrderId = await postOrder([{ menu_id: setup.menu, qty: 2 }]);
  await db.query("UPDATE menus SET deleted_at = UTC_TIMESTAMP(), is_active = FALSE WHERE id = ?", [setup.menu]);
  await release(firstOrderId, "terjual");
  expect(await getStock(setup.menu)).toEqual({ held: 0, sold: 2, total: 2 });
});

test("menu stock_date NULL + pesanan lama stock_date NULL → penghitung harian tidak disentuh", async () => {
  const firstOrderId = await postOrder([{ menu_id: setup.menu, qty: 2 }]);
  await db.query("UPDATE orders SET stock_date = NULL WHERE id = ?", [firstOrderId]);
  await db.query("UPDATE menus SET stock_date = NULL, held_today = 2, sold_today = 1 WHERE id = ?", [setup.menu]);
  await release(firstOrderId, "terjual");
  expect(await getStock(setup.menu)).toEqual({ held: 2, sold: 1, total: 2 });
});

test("held_today dijepit ≥ 0", async () => {
  const firstOrderId = await postOrder([{ menu_id: setup.menu, qty: 2 }]);
  await db.query("UPDATE menus SET held_today = 1 WHERE id = ?", [setup.menu]);
  await release(firstOrderId, "kembali");
  expect((await getStock(setup.menu)).held).toBe(0);
});

test("dua menu (baris menu sama dijumlah) → keduanya diperbarui; stock_date NULL → penghitung harian tetap", async () => {
  const firstOrderId = await postOrder([
    { menu_id: setup.menu, qty: 1 },
    { menu_id: setup.menu2, qty: 3 },
    { menu_id: setup.menu, qty: 2 },
  ]);
  await release(firstOrderId, "terjual");
  expect(await getStock(setup.menu)).toEqual({ held: 0, sold: 3, total: 3 });
  expect(await getStock(setup.menu2)).toEqual({ held: 0, sold: 3, total: 3 });

  const secondOrderId = await postOrder([{ menu_id: setup.menu, qty: 2 }]);
  await db.query("UPDATE orders SET stock_date = NULL WHERE id = ?", [secondOrderId]);
  await release(secondOrderId, "terjual");
  expect(await getStock(setup.menu)).toEqual({ held: 2, sold: 3, total: 5 });
});

// Batas porsi: batas 3 pesanan menunggu tidak cukup (satu pesanan bisa berisi ratusan porsi); porsi tertahan juga dibatasi
test("satu pembeli maksimal 20 porsi menunggu", async () => {
  const bigMenu = await insertMenu(setup.idA, { name: "Nasi Kotak", daily_quota: 100, quota_today: 100 });
  await postOrder([{ menu_id: bigMenu, qty: 15 }]);
  const res = await request(app)
    .post("/api/v1/orders")
    .set("Authorization", `Bearer ${setup.customerToken}`)
    .set("Idempotency-Key", randomUUID())
    .send({ items: [{ menu_id: bigMenu, qty: 6 }], pickup_point_id: 1, payment_method: "cod" })
    .expect(409);
  expect(res.body.error.message).toBe(
    "Maksimal 20 porsi menunggu per pembeli. Selesaikan atau batalkan pesanan lain dulu.",
  );
  expect((await menuRow(bigMenu)).held_today).toBe(15);
  await postOrder([{ menu_id: bigMenu, qty: 5 }]); // tepat 20 masih boleh
});
