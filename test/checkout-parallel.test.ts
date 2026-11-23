import { randomUUID } from "node:crypto";
import request from "supertest";
import { beforeEach, describe, expect, test } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { menuRow, createCustomer, prepareCheckout } from "./helpers/merchant";

// F06 Task 4: idempotensi & checkout paralel tanpa oversell (R-02, BE-03, D4, D6, D11)
let setup: Awaited<ReturnType<typeof prepareCheckout>>;

const pesan = (token: string, key: string, item: Record<string, unknown> = {}) =>
  request(app)
    .post("/api/v1/orders")
    .set("Authorization", `Bearer ${token}`)
    .set("Idempotency-Key", key)
    .send({ items: [{ menu_id: setup.menu, qty: 1, ...item }], pickup_point_id: 1, payment_method: "cod" });
const count = async (sql: string, args: unknown[] = []) =>
  Number(((await db.query<any[]>(sql, args))[0] as any[])[0].n);
const kuota = (quota: number) =>
  db.query("UPDATE menus SET daily_quota = ?, quota_today = ? WHERE id = ?", [quota, quota, setup.menu]);
const status = (responses: { status: number }[]) => responses.map((res) => res.status).sort();

beforeEach(async () => {
  setup = await prepareCheckout();
});

describe("tanpa oversell (R-02)", () => {
  test("sisa 1, 2 pembeli paralel → tepat 1 sukses", async () => {
    await kuota(1);
    const lain = await createCustomer(1);
    const responses = await Promise.all([pesan(setup.customerToken, randomUUID()), pesan(lain, randomUUID())]);
    expect(status(responses)).toEqual([201, 409]);
    expect(responses.find((res) => res.status === 409)!.body.error.code).toBe("OUT_OF_STOCK");
    expect((await menuRow(setup.menu)).held_today).toBe(1);
    expect(await count("SELECT COUNT(*) n FROM orders")).toBe(1);
  });

  test("sisa 3, 5 pembeli paralel → tepat 3 sukses, sisa tidak negatif", async () => {
    await kuota(3);
    const tokens = [];
    for (let i = 1; i <= 5; i++) tokens.push(await createCustomer(i));
    const responses = await Promise.all(tokens.map((token) => pesan(token, randomUUID())));
    expect(status(responses)).toEqual([201, 201, 201, 409, 409]);
    const menu = await menuRow(setup.menu);
    expect(menu.held_today).toBe(3);
    expect(menu.quota_today - menu.sold_today - menu.held_today).toBe(0);
    expect(await count("SELECT SUM(qty) n FROM order_items")).toBe(3);
  });

  test("D11: 1 pembeli, 5 kunci berbeda paralel → tepat 3 sukses, sisanya CONFLICT batas", async () => {
    const responses = await Promise.all(Array.from({ length: 5 }, () => pesan(setup.customerToken, randomUUID())));
    expect(status(responses)).toEqual([201, 201, 201, 409, 409]);
    for (const res of responses.filter((response) => response.status === 409)) {
      expect(res.body.error).toMatchObject({
        code: "CONFLICT",
        message: "Masih ada 3 pesanan yang menunggu. Selesaikan atau batalkan dulu.",
      });
    }
    expect(await count("SELECT COUNT(*) n FROM orders")).toBe(3);
    expect((await menuRow(setup.menu)).held_today).toBe(3);
  });
});

describe("idempotensi (D6)", () => {
  test("kunci sama, 3 paralel → 1 pesanan, kode sama, stok ditahan sekali", async () => {
    const idempotencyKey = randomUUID();
    const responses = await Promise.all([1, 2, 3].map(() => pesan(setup.customerToken, idempotencyKey, { qty: 2 })));
    expect(status(responses)).toEqual([201, 201, 201]);
    expect(new Set(responses.map((res) => res.body.data.code)).size).toBe(1);
    expect(await count("SELECT COUNT(*) n FROM orders")).toBe(1);
    expect((await menuRow(setup.menu)).held_today).toBe(2);
    const [rows] = await db.query<any[]>("SELECT order_id FROM order_idempotency");
    expect(rows).toHaveLength(1);
    expect(rows[0].order_id).not.toBeNull();
  });

  test("replay berurutan: setelah stok habis & status berubah → 201 kode sama, keadaan terkini, stok tetap", async () => {
    const idempotencyKey = randomUUID();
    const first = await pesan(setup.customerToken, idempotencyKey).expect(201);
    await db.query("UPDATE menus SET held_today = quota_today WHERE id = ?", [setup.menu]);
    await db.query("UPDATE orders SET status = 'confirmed'");
    const sebelum = await menuRow(setup.menu);
    const second = await pesan(setup.customerToken, idempotencyKey).expect(201);
    expect(second.body.data).toMatchObject({ code: first.body.data.code, status: "confirmed" });
    expect(await menuRow(setup.menu)).toEqual(sebelum);
  });

  test("isi beda → 409; urutan option_ids berbeda dianggap sama", async () => {
    const [result] = await db.query<any>(
      "INSERT INTO menu_options (menu_id, name, extra_price) VALUES (?, 'Telur', 4000)",
      [setup.menu],
    );
    const [lowId, highId] = [setup.keju, result.insertId as number].sort((left, right) => left - right);
    const idempotencyKey = randomUUID();
    const first = await pesan(setup.customerToken, idempotencyKey, { option_ids: [highId, lowId] }).expect(201);
    const second = await pesan(setup.customerToken, idempotencyKey, { option_ids: [lowId, highId] }).expect(201);
    expect(second.body.data.code).toBe(first.body.data.code);
    const res = await pesan(setup.customerToken, idempotencyKey, { qty: 2, option_ids: [lowId, highId] }).expect(409);
    expect(res.body.error).toEqual({
      code: "CONFLICT",
      message: "Pesanan ini sudah dikirim dengan isi berbeda. Muat ulang lalu coba lagi.",
    });
  });

  test("gagal lalu ulang dengan kunci sama → boleh", async () => {
    await kuota(0);
    const idempotencyKey = randomUUID();
    expect((await pesan(setup.customerToken, idempotencyKey).expect(409)).body.error.code).toBe("OUT_OF_STOCK");
    await kuota(5);
    await pesan(setup.customerToken, idempotencyKey).expect(201);
    expect(await count("SELECT COUNT(*) n FROM orders")).toBe(1);
  });

  test("lingkup per pembeli; huruf besar = huruf kecil", async () => {
    const idempotencyKey = randomUUID();
    const first = await pesan(setup.customerToken, idempotencyKey).expect(201);
    const second = await pesan(await createCustomer(1), idempotencyKey).expect(201);
    expect(second.body.data.code).not.toBe(first.body.data.code);
    const third = await pesan(setup.customerToken, idempotencyKey.toUpperCase()).expect(201);
    expect(third.body.data.code).toBe(first.body.data.code);
    expect(await count("SELECT COUNT(*) n FROM orders")).toBe(2);
  });
});
