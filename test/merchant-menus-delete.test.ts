import request from "supertest";
import { beforeEach, expect, test } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { createAdmin } from "../src/scripts/create-admin";
import { login, menuRow, prepareMerchants, insertMenu } from "./helpers/merchant";

let tokenA: string, tokenB: string, idA: number;

const req = (method: "get" | "patch" | "delete", path: string, token = tokenA) =>
  request(app)[method](`/api/v1/merchant${path}`).set("Authorization", `Bearer ${token}`);

beforeEach(async () => {
  ({ tokenA, tokenB, idA } = await prepareMerchants());
});

test("nonaktif lewat PATCH is_active: tetap tampil sebagai inactive, bisa diaktifkan lagi", async () => {
  const id = await insertMenu(idA);
  expect((await req("patch", `/menus/${id}`).send({ is_active: false }).expect(200)).body.data.is_active).toBe(false);
  expect((await req("get", "/menus?status=inactive").expect(200)).body.data.map((menu: any) => menu.id)).toEqual([id]);
  expect((await req("patch", `/menus/${id}`).send({ is_active: true }).expect(200)).body.data.is_active).toBe(true);
  expect((await req("get", "/menus?status=inactive").expect(200)).body.data).toEqual([]);
});

test("DELETE → 204 soft delete; semua rute penjual lalu 404; baris tetap ada", async () => {
  const id = await insertMenu(idA);
  const deleteRes = await req("delete", `/menus/${id}`).expect(204);
  expect(deleteRes.text).toBe("");
  for (const [method, path] of [
    ["get", `/menus/${id}`],
    ["patch", `/menus/${id}`],
    ["delete", `/menus/${id}`],
  ] as const) {
    // …/quota terhapus → 404 diuji di merchant-quota.test.ts
    const res = await req(method, path)
      .send(method === "patch" ? { name: "x" } : undefined)
      .expect(404);
    expect(res.body.error.message).toBe("Menu tidak ditemukan.");
  }
  expect((await req("get", "/menus").expect(200)).body.data).toEqual([]);
  const row = await menuRow(id);
  expect(row.deleted_at).not.toBeNull();
  expect(row.is_active).toBe(0);
});

test("menu yang sudah dipesan tetap bisa dihapus, order_items utuh", async () => {
  const id = await insertMenu(idA, { name: "Nasi Ayam", price: 15000, hpp: 9000 });
  const [[cust]] = await db.query<any[]>("SELECT id FROM users WHERE email = 'budi@mail.com'");
  const [result] = await db.query<any>(
    `INSERT INTO orders (code, customer_id, merchant_id, pickup_point_id, status, customer_name, customer_phone, subtotal, total, payment_method, hold_until)
     VALUES ('KK-20261101-0001', ?, ?, 1, 'completed', 'Budi', '081234567890', 30000, 30000, 'cod', UTC_TIMESTAMP())`,
    [cust.id, idA],
  );
  await db.query(
    "INSERT INTO order_items (order_id, menu_id, menu_name, unit_price, hpp, qty, line_total) VALUES (?, ?, 'Nasi Ayam', 15000, 9000, 2, 30000)",
    [result.insertId, id],
  );
  const [before] = await db.query<any[]>("SELECT * FROM order_items WHERE menu_id = ?", [id]);
  await req("delete", `/menus/${id}`).expect(204);
  const [after] = await db.query<any[]>("SELECT * FROM order_items WHERE menu_id = ?", [id]);
  expect(after).toEqual(before);
});

test("penjual B DELETE menu A → 404, menu A utuh; id aneh → 404", async () => {
  const id = await insertMenu(idA);
  const before = await menuRow(id);
  await req("delete", `/menus/${id}`, tokenB).expect(404);
  expect(await menuRow(id)).toEqual(before);
  await req("delete", "/menus/abc").expect(404);
});

test("checklist toko di panel admin: hapus atau nonaktif membuat active_menu & menu_with_photo false", async () => {
  await createAdmin({ phone: "081300000009", fullName: "Admin Uji", password: "rahasia123" });
  const adminToken = await login("081300000009");
  const cek = async () =>
    (await request(app).get(`/api/v1/admin/merchants/${idA}`).set("Authorization", `Bearer ${adminToken}`).expect(200))
      .body.data.checklist;
  const id = await insertMenu(idA, { image_url: "/menu/1.png" });
  expect(await cek()).toMatchObject({ active_menu: true, menu_with_photo: true });
  await req("patch", `/menus/${id}`).send({ is_active: false }).expect(200);
  expect(await cek()).toMatchObject({ active_menu: false, menu_with_photo: false });
  await req("patch", `/menus/${id}`).send({ is_active: true }).expect(200);
  expect(await cek()).toMatchObject({ active_menu: true, menu_with_photo: true });
  await req("delete", `/menus/${id}`).expect(204);
  expect(await cek()).toMatchObject({ active_menu: false, menu_with_photo: false });
});
