import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import db from "../src/config/db";
import { hariIniWib } from "../src/services/merchant-kuota.service";
import { dalamTransaksi } from "../src/services/admin-audit.service";
import { Aksi, Aktor, Status, transisi } from "../src/services/pesanan-status.service";
import { menuRow, pembeliBaru, pesanDulu, siapCheckout } from "./helpers/toko";

// F07 Task 1: mesin status & stok tepat sekali (C-15, C-16, M-04, M-08, R-03; D1–D7)
let s: Awaited<ReturnType<typeof siapCheckout>>;
let penjual: Aktor;
let penjualB: Aktor;
let pembeli: Aktor;
let pembeliB: Aktor;
const sistem: Aktor = { jenis: "system" };

const BERUBAH = "Pesanan sudah berubah status.";
const HABIS = "Batas waktu pesanan sudah habis.";
const jalan = (code: string, aksi: Aksi, aktor: Aktor, reason?: string | null) =>
  dalamTransaksi((c) => transisi(c, code, aksi, aktor, reason));
const pesanan = async (code: string) => ((await db.query<any[]>("SELECT * FROM orders WHERE code = ?", [code]))[0] as any[])[0];
const log = async (code: string) => (await db.query<any[]>(
  "SELECT l.from_status, l.to_status, l.actor_user_id FROM order_status_logs l JOIN orders o ON o.id = l.order_id WHERE o.code = ? ORDER BY l.id",
  [code],
))[0] as any[];
const stok = async () => {
  const m = await menuRow(s.menu);
  return { held: m.held_today, sold: m.sold_today, total: m.sold_total };
};
// pesanan qty 2 dengan status awal disiapkan lewat SQL
const siap = async (status: Status = "holding", o: Record<string, unknown> = {}) => {
  const code = await pesanDulu(s.tCust, s.menu, 2);
  await db.query("UPDATE orders SET ? WHERE code = ?", [{ status, ...o }, code]);
  return code;
};
const lewat = (code: string) => db.query("UPDATE orders SET hold_until = UTC_TIMESTAMP() - INTERVAL 1 MINUTE WHERE code = ?", [code]);

beforeAll(async () => {
  s = await siapCheckout();
  const id = async (email: string) => Number(((await db.query<any[]>("SELECT id FROM users WHERE email = ?", [email]))[0] as any[])[0].id);
  penjual = { jenis: "merchant", userId: await id("siti@mail.com"), merchantId: s.idA };
  penjualB = { jenis: "merchant", userId: await id("andi@mail.com"), merchantId: s.idB };
  pembeli = { jenis: "customer", userId: await id("budi@mail.com") };
  await pembeliBaru(1);
  pembeliB = { jenis: "customer", userId: await id("pembeli1@mail.com") };
});
// batas 3 holding per pembeli & stok menu dikembalikan agar tiap test mulai bersih
afterEach(async () => {
  await db.query("UPDATE orders SET status = 'expired' WHERE status = 'holding'");
  await db.query("UPDATE menus SET held_today = 0, sold_today = 0, sold_total = 0, deleted_at = NULL, is_active = TRUE, stock_date = ?",
    [hariIniWib()]);
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("tabel D1: aksi × status asal", () => {
  const SAH: Record<Aksi, Partial<Record<Status, Status>>> = {
    confirm: { holding: "confirmed" }, cook: { confirmed: "cooking" }, ready: { cooking: "ready" }, complete: { ready: "completed" },
    reject: { holding: "cancelled", confirmed: "cancelled" }, cancel: { holding: "cancelled", confirmed: "cancelled" },
    expire: { holding: "expired" },
  };
  const STATUS: Status[] = ["holding", "confirmed", "cooking", "ready", "completed", "cancelled", "expired"];
  const aktor = (a: Aksi) => (a === "cancel" || a === "complete" ? pembeli : a === "expire" ? sistem : penjual);
  const kasus = (Object.keys(SAH) as Aksi[]).flatMap((aksi) => STATUS.map((dari) => [aksi, dari, SAH[aksi][dari] ?? null] as const));

  test.each(kasus)("%s dari %s → %s", async (aksi, dari, ke) => {
    const code = await siap(dari);
    if (aksi === "expire") await lewat(code);
    const p = jalan(code, aksi, aktor(aksi), aksi === "reject" ? "Stok habis" : undefined);
    if (ke) {
      await expect(p).resolves.toMatchObject({ dari, ke });
      expect((await pesanan(code)).status).toBe(ke);
    } else {
      await expect(p).rejects.toMatchObject({ status: 409, code: "CONFLICT", message: BERUBAH });
      expect((await pesanan(code)).status).toBe(dari);
    }
  });

  test("complete juga sah untuk penjual", async () => {
    const code = await siap("ready");
    await expect(jalan(code, "complete", penjual)).resolves.toMatchObject({ ke: "completed" });
  });
});

describe("aktor & kepemilikan", () => {
  test.each([
    ["confirm", "customer"], ["cook", "customer"], ["reject", "customer"], ["cancel", "merchant"], ["confirm", "system"],
  ] as const)("%s oleh %s → 409", async (aksi, jenis) => {
    const code = await siap(aksi === "cook" ? "confirmed" : "holding");
    const a = jenis === "customer" ? pembeli : jenis === "merchant" ? penjual : sistem;
    await expect(jalan(code, aksi, a, "x")).rejects.toMatchObject({ status: 409, message: BERUBAH });
  });

  test("pembeli B / toko B → 404, status tetap", async () => {
    const code = await siap("holding");
    await expect(jalan(code, "cancel", pembeliB)).rejects.toMatchObject({ status: 404, message: "Pesanan tidak ditemukan." });
    await expect(jalan(code, "confirm", penjualB)).rejects.toMatchObject({ status: 404, message: "Pesanan tidak ditemukan." });
    await expect(jalan("KK-00000000-XXXX", "confirm", penjual)).rejects.toMatchObject({ status: 404 });
    expect((await pesanan(code)).status).toBe("holding");
  });
});

describe("pembayaran (D1, D3)", () => {
  test("cancel dari confirmed non-tunai → 409", async () => {
    const code = await siap("confirmed", { payment_method: "qris" });
    await expect(jalan(code, "cancel", pembeli)).rejects.toMatchObject({ status: 409, message: BERUBAH });
  });

  test("confirm qris belum lunas → 409 belum dibayar; lunas → sukses", async () => {
    const code = await siap("holding", { payment_method: "qris" });
    await expect(jalan(code, "confirm", penjual)).rejects.toMatchObject({ status: 409, message: "Pesanan belum dibayar." });
    await db.query("UPDATE orders SET payment_status = 'paid' WHERE code = ?", [code]);
    await expect(jalan(code, "confirm", penjual)).resolves.toMatchObject({ ke: "confirmed" });
  });
});

describe("lewat waktu (D2)", () => {
  test.each(["confirm", "cancel", "reject"] as const)("%s → 409 habis, status & held tetap", async (aksi) => {
    const code = await siap("holding");
    await lewat(code);
    await expect(jalan(code, aksi, aksi === "cancel" ? pembeli : penjual, "Stok habis"))
      .rejects.toMatchObject({ status: 409, message: HABIS });
    expect((await pesanan(code)).status).toBe("holding");
    expect((await stok()).held).toBe(2);
  });

  test("expire → expired oleh sistem, held kembali, log aktor NULL", async () => {
    const code = await siap("holding");
    await lewat(code);
    await jalan(code, "expire", sistem);
    const o = await pesanan(code);
    expect(o).toMatchObject({ status: "expired", cancelled_by: "system", cancel_reason: "Tidak dikonfirmasi tepat waktu." });
    expect(o.cancelled_at).not.toBeNull();
    expect(await stok()).toEqual({ held: 0, sold: 0, total: 0 });
    expect((await log(code)).at(-1)).toEqual({ from_status: "holding", to_status: "expired", actor_user_id: null });
  });

  test("expire sebelum lewat → 409", async () => {
    const code = await siap("holding");
    await expect(jalan(code, "expire", sistem)).rejects.toMatchObject({ status: 409, message: BERUBAH });
  });
});

describe("kolom & log (D7)", () => {
  test("confirm → confirmed_at, log, updated_at bergeser", async () => {
    const code = await siap("holding");
    await db.query("UPDATE orders SET updated_at = UTC_TIMESTAMP() - INTERVAL 1 HOUR WHERE code = ?", [code]);
    const sebelum = (await pesanan(code)).updated_at.getTime();
    await jalan(code, "confirm", penjual);
    const o = await pesanan(code);
    expect(o.confirmed_at).not.toBeNull();
    expect(o.updated_at.getTime()).toBeGreaterThan(sebelum);
    expect(await log(code)).toEqual([
      { from_status: null, to_status: "holding", actor_user_id: (pembeli as { userId: number }).userId },
      { from_status: "holding", to_status: "confirmed", actor_user_id: (penjual as { userId: number }).userId },
    ]);
  });

  test("reject dipangkas → cancel_reason, cancelled_by merchant", async () => {
    const code = await siap("holding");
    await jalan(code, "reject", penjual, "  Stok habis  ");
    expect(await pesanan(code)).toMatchObject({ status: "cancelled", cancel_reason: "Stok habis", cancelled_by: "merchant" });
    expect((await pesanan(code)).cancelled_at).not.toBeNull();
  });

  test("cancel tanpa alasan → NULL, cancelled_by customer", async () => {
    const code = await siap("holding");
    await jalan(code, "cancel", pembeli, "   ");
    expect(await pesanan(code)).toMatchObject({ cancel_reason: null, cancelled_by: "customer" });
  });

  test("complete tunai → paid, completed_at", async () => {
    const code = await siap("ready");
    await jalan(code, "complete", pembeli);
    const o = await pesanan(code);
    expect(o.payment_status).toBe("paid");
    expect(o.completed_at).not.toBeNull();
  });
});

describe("stok (D4), qty 2", () => {
  test("confirm → held −2, sold +2", async () => {
    const code = await siap("holding");
    await jalan(code, "confirm", penjual);
    expect(await stok()).toEqual({ held: 0, sold: 2, total: 2 });
  });

  test("cancel dari holding → held −2", async () => {
    const code = await siap("holding");
    await jalan(code, "cancel", pembeli);
    expect(await stok()).toEqual({ held: 0, sold: 0, total: 0 });
  });

  test("reject dari confirmed → sold −2, held tetap; cook/ready/complete tidak menyentuh menu", async () => {
    const code = await siap("holding");
    await jalan(code, "confirm", penjual);
    const a = await siap("holding"); // held 2 milik pesanan lain
    await jalan(code, "reject", penjual, "Stok habis");
    expect(await stok()).toEqual({ held: 2, sold: 0, total: 0 });

    await jalan(a, "confirm", penjual);
    const sebelum = await stok();
    await jalan(a, "cook", penjual);
    await jalan(a, "ready", penjual);
    await jalan(a, "complete", penjual);
    expect(await stok()).toEqual(sebelum);
  });

  test("lintas hari: reject dari confirmed → sold_today hari baru tetap, sold_total −2", async () => {
    const code = await siap("holding");
    await jalan(code, "confirm", penjual);
    await db.query("UPDATE menus SET stock_date = DATE_ADD(stock_date, INTERVAL 1 DAY), held_today = 5, sold_today = 1 WHERE id = ?", [s.menu]);
    await jalan(code, "reject", penjual, "Stok habis");
    expect(await stok()).toEqual({ held: 5, sold: 1, total: 0 });
  });

  test("jepit ≥ 0: sold_today dipaksa 1 → 0", async () => {
    const code = await siap("holding");
    await jalan(code, "confirm", penjual);
    await db.query("UPDATE menus SET sold_today = 1, sold_total = 1 WHERE id = ?", [s.menu]);
    await jalan(code, "cancel", pembeli);
    expect(await stok()).toEqual({ held: 0, sold: 0, total: 0 });
  });

  test("menu terhapus tetap dilepas mode batal", async () => {
    const code = await siap("holding");
    await jalan(code, "confirm", penjual);
    await db.query("UPDATE menus SET deleted_at = UTC_TIMESTAMP(), is_active = FALSE WHERE id = ?", [s.menu]);
    await jalan(code, "reject", penjual, "Stok habis");
    expect(await stok()).toEqual({ held: 0, sold: 0, total: 0 });
  });
});
