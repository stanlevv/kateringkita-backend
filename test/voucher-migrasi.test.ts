import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import db from "../src/config/db";
import { pesanDulu, siapCheckout } from "./helpers/toko";

// Migrasi 014: kolom & tabel voucher, dan backfill potongan pesanan lama (promo_id tunggal) ke slot toko / platform
const SQL = readFileSync(join(__dirname, "../database/migrations/014_voucher.sql"), "utf8");
const BACKFILL = /-- backfill[^\n]*\n([\s\S]*?;)/.exec(SQL)?.[1] ?? "";

let s: Awaited<ReturnType<typeof siapCheckout>>;
const promo = async (merchantId: number | null, code: string) => {
  const [r] = await db.query<any>(
    `INSERT INTO promos (merchant_id, code, type, value, min_subtotal, starts_at, ends_at)
     VALUES (?, ?, 'fixed', 3000, 0, UTC_TIMESTAMP() - INTERVAL 1 DAY, UTC_TIMESTAMP() + INTERVAL 1 DAY)`, [merchantId, code],
  );
  return r.insertId as number;
};
const pesanan = async (code: string) => ((await db.query<any[]>("SELECT * FROM orders WHERE code = ?", [code]))[0] as any[])[0];

beforeAll(async () => {
  s = await siapCheckout();
});

describe("migrasi 014 voucher", () => {
  test("kolom & tabel baru ada dengan bawaan yang benar", async () => {
    const id = await promo(s.idA, "BARU1");
    const [[p]] = await db.query<any[]>("SELECT is_public FROM promos WHERE id = ?", [id]);
    expect(Boolean(p.is_public)).toBe(true);
    const code = await pesanDulu(s.tCust, s.menu);
    expect(await pesanan(code)).toMatchObject({ merchant_promo_id: null, merchant_discount: 0, platform_promo_id: null, platform_discount: 0 });
    const [[u]] = await db.query<any[]>("SELECT id FROM users WHERE email = 'budi@mail.com'");
    await db.query("INSERT INTO promo_claims (promo_id, user_id) VALUES (?, ?)", [id, u.id]);
    await expect(db.query("INSERT INTO promo_claims (promo_id, user_id) VALUES (?, ?)", [id, u.id])).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
    // dua voucher per pesanan → dua baris redemption; promo yang sama dua kali di pesanan yang sama tetap ditolak
    const id2 = await promo(null, "BARU2");
    const [[o]] = await db.query<any[]>("SELECT id FROM orders WHERE code = ?", [code]);
    const tebus = (p: number) => db.query("INSERT INTO promo_redemptions (promo_id, order_id, user_id, amount) VALUES (?, ?, ?, 1)", [p, o.id, u.id]);
    await tebus(id);
    await tebus(id2);
    await expect(tebus(id)).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
  });

  test("backfill: promo_id lama → slot toko atau platform sesuai pemilik promo", async () => {
    expect(BACKFILL).toMatch(/^UPDATE orders/);
    const toko = await promo(s.idA, "LAMATOKO");
    const platform = await promo(null, "LAMAPLAT");
    const a = await pesanDulu(s.tCust, s.menu);
    const b = await pesanDulu(s.tCust, s.menu2);
    await db.query("UPDATE orders SET promo_id = ?, discount = 3000 WHERE code = ?", [toko, a]);
    await db.query("UPDATE orders SET promo_id = ?, discount = 2500 WHERE code = ?", [platform, b]);
    await db.query(BACKFILL);
    expect(await pesanan(a)).toMatchObject({ merchant_promo_id: toko, merchant_discount: 3000, platform_promo_id: null, platform_discount: 0 });
    expect(await pesanan(b)).toMatchObject({ merchant_promo_id: null, merchant_discount: 0, platform_promo_id: platform, platform_discount: 2500 });
  });
});
