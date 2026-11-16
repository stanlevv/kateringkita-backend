import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { env } from "../src/config/env";
import { bekukanJam, siapCheckout } from "./helpers/toko";

// Voucher: satu voucher toko + satu voucher platform per pesanan; kuota berkurang saat pesanan dibuat, kembali saat batal.
let s: Awaited<ReturnType<typeof siapCheckout>>;
type P = { merchant_id?: number | null; code: string; type?: string; value?: number; max_discount?: number | null; min_subtotal?: number; quota?: number | null; used_count?: number; per_user_limit?: number };
const promo = async (p: P) => {
  const [r] = await db.query<any>(
    `INSERT INTO promos (merchant_id, code, type, value, max_discount, min_subtotal, quota, used_count, per_user_limit, starts_at, ends_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP() - INTERVAL 1 DAY, UTC_TIMESTAMP() + INTERVAL 1 DAY)`,
    [p.merchant_id ?? null, p.code, p.type ?? "fixed", p.value ?? 0, p.max_discount ?? null, p.min_subtotal ?? 0, p.quota ?? null,
      p.used_count ?? 0, p.per_user_limit ?? 5],
  );
  return r.insertId as number;
};
const body = (extra: Record<string, unknown>) => ({ items: [{ menu_id: s.menu, qty: 2 }], pickup_point_id: 1, ...extra }); // subtotal 30.000
const quote = (extra: Record<string, unknown>) =>
  request(app).post("/api/v1/orders/quote").set("Authorization", `Bearer ${s.tCust}`).send(body(extra));
const pesan = (extra: Record<string, unknown>, payment_method = "va") =>
  request(app).post("/api/v1/orders").set("Authorization", `Bearer ${s.tCust}`).set("Idempotency-Key", randomUUID())
    .send(body({ payment_method, ...extra }));
const promoRow = async (id: number) => ((await db.query<any[]>("SELECT used_count FROM promos WHERE id = ?", [id]))[0] as any[])[0];
const order = async (code: string) => ((await db.query<any[]>("SELECT * FROM orders WHERE code = ?", [code]))[0] as any[])[0];

let toko10: number, hemat3k: number;
beforeAll(async () => {
  s = await siapCheckout();
  toko10 = await promo({ merchant_id: s.idA, code: "TOKO10", type: "percent", value: 10, max_discount: 5000 });
  hemat3k = await promo({ code: "HEMAT3K", type: "fixed", value: 3000 });
  await promo({ merchant_id: s.idA, code: "TOKO5", type: "fixed", value: 500 });
  await promo({ merchant_id: s.idB, code: "LAINB", type: "fixed", value: 1000 });
});
beforeEach(() => {
  bekukanJam();
  env.MIDTRANS_SERVER_KEY = "SB-Mid-server-uji";
});
afterEach(async () => {
  env.MIDTRANS_SERVER_KEY = undefined;
  await db.query("UPDATE orders SET status = 'expired' WHERE status = 'holding'");
  await db.query("UPDATE menus SET held_today = 0");
});

describe("quote dua voucher", () => {
  test("toko dihitung dari subtotal, platform dari sisa; vouchers_applied per slot", async () => {
    const d = (await quote({ promo_codes: ["toko10", "HEMAT3K"] }).expect(200)).body.data;
    expect(d).toMatchObject({ subtotal: 30000, merchant_discount: 3000, platform_discount: 3000, discount: 6000 });
    expect(d.total).toBe(30000 + d.service_fee - 6000);
    expect(d.vouchers_applied).toEqual([
      { id: toko10, code: "TOKO10", slot: "toko", amount: 3000 },
      { id: hemat3k, code: "HEMAT3K", slot: "platform", amount: 3000 },
    ]);
  });

  test("dua voucher toko, voucher toko lain, lebih dari 2 kode → 422 di promo_codes", async () => {
    const r = await quote({ promo_codes: ["TOKO10", "TOKO5"] }).expect(422);
    expect(r.body.error.fields.promo_codes).toEqual(["Hanya satu voucher toko per pesanan."]);
    expect((await quote({ promo_codes: ["LAINB"] }).expect(422)).body.error.fields.promo_codes).toEqual(["Kode promo tidak ditemukan."]);
    expect((await quote({ promo_codes: ["TOKO10", "HEMAT3K", "TOKO5"] }).expect(400)).body.error.fields.promo_codes).toBeDefined();
  });

  test("minimal belanja dibandingkan dengan subtotal sebelum diskon", async () => {
    await promo({ code: "MIN31", type: "fixed", value: 1000, min_subtotal: 31000 });
    await promo({ code: "MIN30", type: "fixed", value: 1000, min_subtotal: 30000 });
    expect((await quote({ promo_codes: ["MIN31"] }).expect(422)).body.error.fields.promo_codes).toEqual(["Minimal belanja Rp 31.000 untuk promo ini."]);
    // voucher toko 3.000 tidak membuat subtotal "kurang dari" 30.000 untuk syarat voucher platform
    await quote({ promo_codes: ["TOKO10", "MIN30"] }).expect(200);
  });

  test("voucher toko ≥ subtotal + platform persen → potongan platform 0, total = biaya layanan", async () => {
    await promo({ merchant_id: s.idA, code: "BESAR", type: "fixed", value: 50000 });
    await promo({ code: "PLAT10", type: "percent", value: 10 });
    const d = (await quote({ promo_codes: ["BESAR", "PLAT10"] }).expect(200)).body.data;
    expect(d).toMatchObject({ merchant_discount: 30000, platform_discount: 0 });
    expect(d.total).toBe(d.service_fee);
  });

  test("klien lama: promo_code tunggal tetap jalan; galat juga di fields.promo_code", async () => {
    const d = (await quote({ promo_code: "hemat3k" }).expect(200)).body.data;
    expect(d).toMatchObject({ discount: 3000, platform_discount: 3000, merchant_discount: 0 });
    const r = await quote({ promo_code: "TIDAKADA" }).expect(422);
    expect(r.body.error.fields).toEqual({ promo_codes: ["Kode promo tidak ditemukan."], promo_code: ["Kode promo tidak ditemukan."] });
  });
});

describe("pesanan dua voucher", () => {
  test("tersimpan per slot, promo_id NULL, kuota & redemption per voucher", async () => {
    const before = [await promoRow(toko10), await promoRow(hemat3k)];
    const code = (await pesan({ promo_codes: ["TOKO10", "HEMAT3K"] }).expect(201)).body.data.code;
    expect(await order(code)).toMatchObject({
      promo_id: null, merchant_promo_id: toko10, merchant_discount: 3000, platform_promo_id: hemat3k, platform_discount: 3000, discount: 6000,
    });
    expect((await promoRow(toko10)).used_count).toBe(before[0].used_count + 1);
    expect((await promoRow(hemat3k)).used_count).toBe(before[1].used_count + 1);
    const [red] = await db.query<any[]>(
      "SELECT r.promo_id, r.amount FROM promo_redemptions r JOIN orders o ON o.id = r.order_id WHERE o.code = ? ORDER BY r.promo_id", [code],
    );
    expect(red).toEqual([{ promo_id: toko10, amount: 3000 }, { promo_id: hemat3k, amount: 3000 }].sort((a, b) => a.promo_id - b.promo_id));
  });

  test("batal mengembalikan kuota & redemption kedua voucher; voucher batas 1 bisa dipakai lagi", async () => {
    const t1 = await promo({ merchant_id: s.idA, code: "SEKALITOKO", type: "fixed", value: 1000, quota: 5, per_user_limit: 1 });
    const p1 = await promo({ code: "SEKALIPLAT", type: "fixed", value: 1000, quota: 5, per_user_limit: 1 });
    const code = (await pesan({ promo_codes: ["SEKALITOKO", "SEKALIPLAT"] }).expect(201)).body.data.code;
    await request(app).post(`/api/v1/orders/${code}/cancel`).set("Authorization", `Bearer ${s.tCust}`).send({}).expect(200);
    expect([(await promoRow(t1)).used_count, (await promoRow(p1)).used_count]).toEqual([0, 0]);
    const [[n]] = await db.query<any[]>("SELECT COUNT(*) AS n FROM promo_redemptions WHERE promo_id IN (?, ?)", [t1, p1]);
    expect(Number(n.n)).toBe(0);
    await pesan({ promo_codes: ["SEKALITOKO", "SEKALIPLAT"] }).expect(201);
  });

  test("kuota voucher platform habis → seluruh pesanan ditolak, kuota voucher toko tidak bertambah", async () => {
    const t = await promo({ merchant_id: s.idA, code: "TOKOAMAN", type: "fixed", value: 1000, quota: 10 });
    await promo({ code: "PLATHABIS", type: "fixed", value: 1000, quota: 1, used_count: 1 });
    const r = await pesan({ promo_codes: ["TOKOAMAN", "PLATHABIS"] }).expect(422);
    expect(r.body.error.fields.promo_codes).toEqual(["Kuota promo sudah habis."]);
    expect((await promoRow(t)).used_count).toBe(0);
  });

  test("C1: voucher platform ditolak untuk tunai; voucher toko tetap boleh", async () => {
    const r = await pesan({ promo_codes: ["HEMAT3K"] }, "cod").expect(422);
    expect(r.body.error.fields.promo_codes).toEqual(["Voucher platform hanya untuk bayar non-tunai."]);
    await pesan({ promo_codes: ["TOKO5"] }, "cod").expect(201);
  });

  test("voucher platform yang membuat total Rp 0 ditolak (non-tunai tidak bisa dibayar Rp 0); kuota tidak terpakai", async () => {
    const t = await promo({ merchant_id: s.idA, code: "TOKOPENUH", type: "fixed", value: 50000 });
    const g = await promo({ code: "LAYANANGRATIS", type: "free_service_fee" });
    await db.query("UPDATE app_settings SET setting_value = '2000' WHERE setting_key = 'service_fee'");
    try {
      expect((await quote({ promo_codes: ["TOKOPENUH"] }).expect(200)).body.data.total).toBe(2000);
      const msg = ["Total pesanan jadi Rp 0. Lepas voucher platform."];
      expect((await quote({ promo_codes: ["TOKOPENUH", "LAYANANGRATIS"] }).expect(422)).body.error.fields.promo_codes).toEqual(msg);
      expect((await pesan({ promo_codes: ["TOKOPENUH", "LAYANANGRATIS"] }).expect(422)).body.error.fields.promo_codes).toEqual(msg);
      expect([(await promoRow(t)).used_count, (await promoRow(g)).used_count]).toEqual([0, 0]);
    } finally {
      await db.query("UPDATE app_settings SET setting_value = '0' WHERE setting_key = 'service_fee'");
    }
  });

  test("promo toko yang pernah dipakai pesanan batal bisa dihapus; pesanan lama tetap utuh", async () => {
    const id = await promo({ merchant_id: s.idA, code: "HAPUSAKU", type: "fixed", value: 1000 });
    const code = (await pesan({ promo_codes: ["HAPUSAKU"] }).expect(201)).body.data.code;
    await request(app).post(`/api/v1/orders/${code}/cancel`).set("Authorization", `Bearer ${s.tCust}`).send({}).expect(200);
    await request(app).delete(`/api/v1/merchant/promos/${id}`).set("Authorization", `Bearer ${s.tA}`).expect(200);
    expect(await order(code)).toMatchObject({ merchant_promo_id: null, merchant_discount: 1000, status: "cancelled" });
  });

  test("C2: dua voucher gratis biaya layanan tidak bisa digabung", async () => {
    await promo({ merchant_id: s.idA, code: "TOKOGRATIS", type: "free_service_fee" });
    await promo({ code: "PLATGRATIS", type: "free_service_fee" });
    const r = await quote({ promo_codes: ["TOKOGRATIS", "PLATGRATIS"] }).expect(422);
    expect(r.body.error.fields.promo_codes).toEqual(["Biaya layanan sudah digratiskan voucher lain."]);
    const d = (await quote({ promo_codes: ["TOKO10", "PLATGRATIS"] }).expect(200)).body.data;
    expect(d).toMatchObject({ merchant_discount: 3000, platform_discount: d.service_fee });
  });
});
