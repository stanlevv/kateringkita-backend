import request from "supertest";
import { beforeEach, expect, test } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { createAdmin } from "../src/admin/create";
import { login, menuRow, siapkanToko, sisipMenu } from "./helpers/toko";

let tA: string, tB: string, idA: number;

const req = (method: "get" | "patch" | "delete", u: string, t = tA) =>
  request(app)[method](`/api/v1/merchant${u}`).set("Authorization", `Bearer ${t}`);

beforeEach(async () => {
  ({ tA, tB, idA } = await siapkanToko());
});

test("nonaktif lewat PATCH is_active: tetap tampil sebagai inactive, bisa diaktifkan lagi", async () => {
  const id = await sisipMenu(idA);
  expect((await req("patch", `/menus/${id}`).send({ is_active: false }).expect(200)).body.data.is_active).toBe(false);
  expect((await req("get", "/menus?status=inactive").expect(200)).body.data.map((m: any) => m.id)).toEqual([id]);
  expect((await req("patch", `/menus/${id}`).send({ is_active: true }).expect(200)).body.data.is_active).toBe(true);
  expect((await req("get", "/menus?status=inactive").expect(200)).body.data).toEqual([]);
});

test("DELETE → 204 soft delete; semua rute penjual lalu 404; baris tetap ada", async () => {
  const id = await sisipMenu(idA);
  const r = await req("delete", `/menus/${id}`).expect(204);
  expect(r.text).toBe("");
  for (const [m, u] of [["get", `/menus/${id}`], ["patch", `/menus/${id}`], ["delete", `/menus/${id}`]] as const) { // …/quota terhapus → 404 diuji di merchant-quota.test.ts
    const x = await req(m, u).send(m === "patch" ? { name: "x" } : undefined).expect(404);
    expect(x.body.error.message).toBe("Menu tidak ditemukan.");
  }
  expect((await req("get", "/menus").expect(200)).body.data).toEqual([]);
  const row = await menuRow(id);
  expect(row.deleted_at).not.toBeNull();
  expect(row.is_active).toBe(0);
});

test("R-05: menu yang sudah dipesan tetap bisa dihapus, order_items utuh", async () => {
  const id = await sisipMenu(idA, { name: "Nasi Ayam", price: 15000, hpp: 9000 });
  const [[cust]] = await db.query<any[]>("SELECT id FROM users WHERE email = 'budi@mail.com'");
  const [o] = await db.query<any>(
    `INSERT INTO orders (code, customer_id, merchant_id, pickup_point_id, status, customer_name, customer_phone, subtotal, total, payment_method, hold_until)
     VALUES ('KK-20261101-0001', ?, ?, 1, 'completed', 'Budi', '081234567890', 30000, 30000, 'cod', UTC_TIMESTAMP())`,
    [cust.id, idA],
  );
  await db.query(
    "INSERT INTO order_items (order_id, menu_id, menu_name, unit_price, hpp, qty, line_total) VALUES (?, ?, 'Nasi Ayam', 15000, 9000, 2, 30000)",
    [o.insertId, id],
  );
  const [before] = await db.query<any[]>("SELECT * FROM order_items WHERE menu_id = ?", [id]);
  await req("delete", `/menus/${id}`).expect(204);
  const [after] = await db.query<any[]>("SELECT * FROM order_items WHERE menu_id = ?", [id]);
  expect(after).toEqual(before);
});

test("BE-01: penjual B DELETE menu A → 404, menu A utuh; id aneh → 404", async () => {
  const id = await sisipMenu(idA);
  const before = await menuRow(id);
  await req("delete", `/menus/${id}`, tB).expect(404);
  expect(await menuRow(id)).toEqual(before);
  await req("delete", "/menus/abc").expect(404);
});

test("checklist F18: hapus atau nonaktif membuat active_menu & menu_with_photo false", async () => {
  await createAdmin({ phone: "081300000009", fullName: "Admin Uji", password: "rahasia123" });
  const tAdmin = await login("081300000009");
  const cek = async () =>
    (await request(app).get(`/api/v1/admin/merchants/${idA}`).set("Authorization", `Bearer ${tAdmin}`).expect(200)).body.data.checklist;
  const id = await sisipMenu(idA, { image_url: "/menu/1.png" });
  expect(await cek()).toMatchObject({ active_menu: true, menu_with_photo: true });
  await req("patch", `/menus/${id}`).send({ is_active: false }).expect(200);
  expect(await cek()).toMatchObject({ active_menu: false, menu_with_photo: false });
  await req("patch", `/menus/${id}`).send({ is_active: true }).expect(200);
  expect(await cek()).toMatchObject({ active_menu: true, menu_with_photo: true });
  await req("delete", `/menus/${id}`).expect(204);
  expect(await cek()).toMatchObject({ active_menu: false, menu_with_photo: false });
});
