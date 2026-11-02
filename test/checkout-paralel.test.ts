import { randomUUID } from "node:crypto";
import request from "supertest";
import { beforeEach, describe, expect, test } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { menuRow, pembeliBaru, siapCheckout } from "./helpers/toko";

// F06 Task 4: idempotensi & checkout paralel tanpa oversell (R-02, BE-03, D4, D6, D11)
let s: Awaited<ReturnType<typeof siapCheckout>>;

const pesan = (token: string, key: string, item: Record<string, unknown> = {}) =>
  request(app).post("/api/v1/orders").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", key)
    .send({ items: [{ menu_id: s.menu, qty: 1, ...item }], pickup_point_id: 1, payment_method: "cod" });
const n = async (sql: string, args: unknown[] = []) => Number(((await db.query<any[]>(sql, args))[0] as any[])[0].n);
const kuota = (q: number) => db.query("UPDATE menus SET daily_quota = ?, quota_today = ? WHERE id = ?", [q, q, s.menu]);
const status = (rs: { status: number }[]) => rs.map((r) => r.status).sort();

beforeEach(async () => {
  s = await siapCheckout();
});

describe("tanpa oversell (R-02)", () => {
  test("sisa 1, 2 pembeli paralel → tepat 1 sukses", async () => {
    await kuota(1);
    const lain = await pembeliBaru(1);
    const rs = await Promise.all([pesan(s.tCust, randomUUID()), pesan(lain, randomUUID())]);
    expect(status(rs)).toEqual([201, 409]);
    expect(rs.find((r) => r.status === 409)!.body.error.code).toBe("OUT_OF_STOCK");
    expect((await menuRow(s.menu)).held_today).toBe(1);
    expect(await n("SELECT COUNT(*) n FROM orders")).toBe(1);
  });

  test("sisa 3, 5 pembeli paralel → tepat 3 sukses, sisa tidak negatif", async () => {
    await kuota(3);
    const tokens = [];
    for (let i = 1; i <= 5; i++) tokens.push(await pembeliBaru(i));
    const rs = await Promise.all(tokens.map((t) => pesan(t, randomUUID())));
    expect(status(rs)).toEqual([201, 201, 201, 409, 409]);
    const m = await menuRow(s.menu);
    expect(m.held_today).toBe(3);
    expect(m.quota_today - m.sold_today - m.held_today).toBe(0);
    expect(await n("SELECT SUM(qty) n FROM order_items")).toBe(3);
  });

  test("D11: 1 pembeli, 5 kunci berbeda paralel → tepat 3 sukses, sisanya CONFLICT batas", async () => {
    const rs = await Promise.all(Array.from({ length: 5 }, () => pesan(s.tCust, randomUUID())));
    expect(status(rs)).toEqual([201, 201, 201, 409, 409]);
    for (const r of rs.filter((x) => x.status === 409)) {
      expect(r.body.error).toMatchObject({ code: "CONFLICT", message: "Masih ada 3 pesanan yang menunggu. Selesaikan atau batalkan dulu." });
    }
    expect(await n("SELECT COUNT(*) n FROM orders")).toBe(3);
    expect((await menuRow(s.menu)).held_today).toBe(3);
  });
});

describe("idempotensi (D6)", () => {
  test("kunci sama, 3 paralel → 1 pesanan, kode sama, stok ditahan sekali", async () => {
    const k = randomUUID();
    const rs = await Promise.all([1, 2, 3].map(() => pesan(s.tCust, k, { qty: 2 })));
    expect(status(rs)).toEqual([201, 201, 201]);
    expect(new Set(rs.map((r) => r.body.data.code)).size).toBe(1);
    expect(await n("SELECT COUNT(*) n FROM orders")).toBe(1);
    expect((await menuRow(s.menu)).held_today).toBe(2);
    const [rows] = await db.query<any[]>("SELECT order_id FROM order_idempotency");
    expect(rows).toHaveLength(1);
    expect(rows[0].order_id).not.toBeNull();
  });

  test("replay berurutan: setelah stok habis & status berubah → 201 kode sama, keadaan terkini, stok tetap", async () => {
    const k = randomUUID();
    const a = await pesan(s.tCust, k).expect(201);
    await db.query("UPDATE menus SET held_today = quota_today WHERE id = ?", [s.menu]);
    await db.query("UPDATE orders SET status = 'confirmed'");
    const sebelum = await menuRow(s.menu);
    const b = await pesan(s.tCust, k).expect(201);
    expect(b.body.data).toMatchObject({ code: a.body.data.code, status: "confirmed" });
    expect(await menuRow(s.menu)).toEqual(sebelum);
  });

  test("isi beda → 409; urutan option_ids berbeda dianggap sama", async () => {
    const [o] = await db.query<any>("INSERT INTO menu_options (menu_id, name, extra_price) VALUES (?, 'Telur', 4000)", [s.menu]);
    const [x, y] = [s.keju, o.insertId as number].sort((p, q) => p - q);
    const k = randomUUID();
    const a = await pesan(s.tCust, k, { option_ids: [y, x] }).expect(201);
    const b = await pesan(s.tCust, k, { option_ids: [x, y] }).expect(201);
    expect(b.body.data.code).toBe(a.body.data.code);
    const r = await pesan(s.tCust, k, { qty: 2, option_ids: [x, y] }).expect(409);
    expect(r.body.error).toEqual({ code: "CONFLICT", message: "Pesanan ini sudah dikirim dengan isi berbeda. Muat ulang lalu coba lagi." });
  });

  test("gagal lalu ulang dengan kunci sama → boleh", async () => {
    await kuota(0);
    const k = randomUUID();
    expect((await pesan(s.tCust, k).expect(409)).body.error.code).toBe("OUT_OF_STOCK");
    await kuota(5);
    await pesan(s.tCust, k).expect(201);
    expect(await n("SELECT COUNT(*) n FROM orders")).toBe(1);
  });

  test("lingkup per pembeli; huruf besar = huruf kecil", async () => {
    const k = randomUUID();
    const a = await pesan(s.tCust, k).expect(201);
    const b = await pesan(await pembeliBaru(1), k).expect(201);
    expect(b.body.data.code).not.toBe(a.body.data.code);
    const c = await pesan(s.tCust, k.toUpperCase()).expect(201);
    expect(c.body.data.code).toBe(a.body.data.code);
    expect(await n("SELECT COUNT(*) n FROM orders")).toBe(2);
  });
});
