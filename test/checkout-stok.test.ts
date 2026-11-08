import { randomUUID } from "node:crypto";
import request from "supertest";
import { beforeEach, expect, test } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { dalamTransaksi } from "../src/services/admin-audit.service";
import { lepasStok } from "../src/services/pesanan-stok.service";
import { menuRow, siapCheckout } from "./helpers/toko";

// F06 Task 5: lepasStok untuk F07/F08 (R-01, R-03, R-12, D14)
let s: Awaited<ReturnType<typeof siapCheckout>>;

const pesan = async (items: { menu_id: number; qty: number }[]) => {
  const r = await request(app).post("/api/v1/orders").set("Authorization", `Bearer ${s.tCust}`).set("Idempotency-Key", randomUUID())
    .send({ items, pickup_point_id: 1, payment_method: "cod" }).expect(201);
  const [[o]] = await db.query<any[]>("SELECT id FROM orders WHERE code = ?", [r.body.data.code]);
  return o.id as number;
};
const lepas = (id: number, jadi: "terjual" | "kembali") => dalamTransaksi((c) => lepasStok(c, id, jadi));
const stok = async (id: number) => {
  const m = await menuRow(id);
  return { held: m.held_today, sold: m.sold_today, total: m.sold_total };
};

beforeEach(async () => {
  s = await siapCheckout();
});

test("hari sama: kembali → held turun; terjual → held turun, sold_today & sold_total naik", async () => {
  const a = await pesan([{ menu_id: s.menu, qty: 2 }]);
  expect(await stok(s.menu)).toEqual({ held: 2, sold: 0, total: 0 });
  await lepas(a, "kembali");
  expect(await stok(s.menu)).toEqual({ held: 0, sold: 0, total: 0 });

  const b = await pesan([{ menu_id: s.menu, qty: 2 }]);
  await lepas(b, "terjual");
  expect(await stok(s.menu)).toEqual({ held: 0, sold: 2, total: 2 });
});

test("lintas tengah malam: penghitung harian hari baru tidak disentuh, sold_total tetap naik", async () => {
  const a = await pesan([{ menu_id: s.menu, qty: 2 }]);
  const geser = () => db.query(
    "UPDATE menus SET stock_date = DATE_ADD(stock_date, INTERVAL 1 DAY), held_today = 5, sold_today = 1 WHERE id = ?", [s.menu]);
  await geser();
  await lepas(a, "kembali");
  expect(await stok(s.menu)).toEqual({ held: 5, sold: 1, total: 0 });
  await lepas(a, "terjual");
  expect(await stok(s.menu)).toEqual({ held: 5, sold: 1, total: 2 });
});

test("menu sudah dihapus (soft delete) tetap dilepas", async () => {
  const a = await pesan([{ menu_id: s.menu, qty: 2 }]);
  await db.query("UPDATE menus SET deleted_at = UTC_TIMESTAMP(), is_active = FALSE WHERE id = ?", [s.menu]);
  await lepas(a, "terjual");
  expect(await stok(s.menu)).toEqual({ held: 0, sold: 2, total: 2 });
});

test("menu stock_date NULL + pesanan lama stock_date NULL → penghitung harian tidak disentuh", async () => {
  const a = await pesan([{ menu_id: s.menu, qty: 2 }]);
  await db.query("UPDATE orders SET stock_date = NULL WHERE id = ?", [a]);
  await db.query("UPDATE menus SET stock_date = NULL, held_today = 2, sold_today = 1 WHERE id = ?", [s.menu]);
  await lepas(a, "terjual");
  expect(await stok(s.menu)).toEqual({ held: 2, sold: 1, total: 2 });
});

test("held_today dijepit ≥ 0", async () => {
  const a = await pesan([{ menu_id: s.menu, qty: 2 }]);
  await db.query("UPDATE menus SET held_today = 1 WHERE id = ?", [s.menu]);
  await lepas(a, "kembali");
  expect((await stok(s.menu)).held).toBe(0);
});

test("dua menu (baris menu sama dijumlah) → keduanya diperbarui; stock_date NULL → penghitung harian tetap", async () => {
  const a = await pesan([{ menu_id: s.menu, qty: 1 }, { menu_id: s.menu2, qty: 3 }, { menu_id: s.menu, qty: 2 }]);
  await lepas(a, "terjual");
  expect(await stok(s.menu)).toEqual({ held: 0, sold: 3, total: 3 });
  expect(await stok(s.menu2)).toEqual({ held: 0, sold: 3, total: 3 });

  const b = await pesan([{ menu_id: s.menu, qty: 2 }]);
  await db.query("UPDATE orders SET stock_date = NULL WHERE id = ?", [b]);
  await lepas(b, "terjual");
  expect(await stok(s.menu)).toEqual({ held: 2, sold: 3, total: 5 });
});
