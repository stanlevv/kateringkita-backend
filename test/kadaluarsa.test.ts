import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import db from "../src/config/db";
import { hariIniWib } from "../src/merchant/kuota";
import { dalamTransaksi } from "../src/admin/audit";
import { AppError } from "../src/http/errors";
import { transisi } from "../src/pesanan/status";
import { kadaluarsakan, mulaiJobKadaluarsa, SISTEM } from "../src/pesanan/kadaluarsa";
import { bekukanJam, menuRow, pesanDulu, siapCheckout, sisipMenu, tampilkan } from "./helpers/toko";

// F08 Task 2: job kadaluarsa holding (R-03, X-04, C-21; D2–D7)
let s: Awaited<ReturnType<typeof siapCheckout>>;
let budi: number;
let menuB: number;

const pesanan = async (code: string) => ((await db.query<any[]>("SELECT * FROM orders WHERE code = ?", [code]))[0] as any[])[0];
const n = async (sql: string, args: unknown[] = []) => Number(((await db.query<any[]>(sql, args))[0] as any[])[0].n);
const lewat = (code: string, menit = 1) =>
  db.query("UPDATE orders SET hold_until = UTC_TIMESTAMP() - INTERVAL ? MINUTE WHERE code = ?", [menit, code]);
const asli = (code: string) => dalamTransaksi((c) => transisi(c, code, "expire", SISTEM));
const notifKedaluwarsa = () => n("SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND title = 'Pesanan kedaluwarsa'", [budi]);

beforeAll(async () => {
  s = await siapCheckout();
  budi = Number(((await db.query<any[]>("SELECT id FROM users WHERE email = 'budi@mail.com'"))[0] as any[])[0].id);
  await tampilkan(s.idB);
  await db.query("INSERT INTO merchant_pickup_points (merchant_id, pickup_point_id) VALUES (?, 1)", [s.idB]);
  menuB = await sisipMenu(s.idB);
});
afterEach(async () => {
  vi.restoreAllMocks();
  bekukanJam(); // restoreAllMocks juga melepas jam katalog yang dibekukan siapCheckout
  await db.query("UPDATE orders SET status = 'expired' WHERE status = 'holding'");
  await db.query("UPDATE menus SET held_today = 0, sold_today = 0, sold_total = 0, stock_date = ?", [hariIniWib()]);
  await db.query("DELETE FROM notifications");
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("kadaluarsakan (D1, D4, D5)", () => {
  test("kriteria backlog: lewat waktu → expired, stok kembali, notifikasi; panggilan kedua idempoten", async () => {
    const [a, b, c] = [await pesanDulu(s.tCust, s.menu, 2), await pesanDulu(s.tCust, s.menu, 2), await pesanDulu(s.tCust, s.menu, 2)];
    expect((await menuRow(s.menu)).held_today).toBe(6);
    await lewat(a);
    await lewat(b);
    expect(await kadaluarsakan()).toBe(2);
    for (const code of [a, b]) {
      expect(await pesanan(code)).toMatchObject({ status: "expired", cancelled_by: "system", cancel_reason: "Tidak dikonfirmasi tepat waktu." });
    }
    expect((await pesanan(c)).status).toBe("holding");
    expect((await menuRow(s.menu)).held_today).toBe(2);
    expect(await notifKedaluwarsa()).toBe(2);

    expect(await kadaluarsakan()).toBe(0);
    expect((await menuRow(s.menu)).held_today).toBe(2);
    expect(await notifKedaluwarsa()).toBe(2);
  });

  test("batch & urutan hold_until terlama dulu", async () => {
    const codes = [await pesanDulu(s.tCust, s.menu), await pesanDulu(s.tCust, s.menu), await pesanDulu(s.tCust, s.menu)];
    await lewat(codes[0], 1);
    await lewat(codes[1], 3);
    await lewat(codes[2], 2);
    expect(await kadaluarsakan(1)).toBe(1);
    expect((await pesanan(codes[1])).status).toBe("expired");
    expect((await pesanan(codes[0])).status).toBe("holding");
    expect((await pesanan(codes[2])).status).toBe("holding");
    expect(await kadaluarsakan(2)).toBe(2);
    expect((await pesanan(codes[0])).status).toBe("expired");
  });

  test("satu gagal tidak menghentikan sisanya; log tanpa data pembeli", async () => {
    const codes = [await pesanDulu(s.tCust, s.menu), await pesanDulu(s.tCust, s.menu), await pesanDulu(s.tCust, s.menu)];
    await lewat(codes[0], 3);
    await lewat(codes[1], 2);
    await lewat(codes[2], 1);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const expire = (code: string) => (code === codes[0] ? Promise.reject(new Error("boom")) : asli(code));
    expect(await kadaluarsakan(100, expire)).toBe(2);
    expect((await pesanan(codes[0])).status).toBe("holding");
    expect(err).toHaveBeenCalledTimes(1);
    const teks = String(err.mock.calls[0].join(" "));
    expect(teks).toContain(codes[0]);
    expect(teks).toContain("boom");
    expect(teks).not.toContain("Budi");
    expect(teks).not.toContain("081234567890");
  });

  test("AppError 409/404 dilewati tanpa log galat", async () => {
    const code = await pesanDulu(s.tCust, s.menu);
    await lewat(code);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await kadaluarsakan(100, () => Promise.reject(new AppError(409, "CONFLICT", "x")))).toBe(0);
    expect(await kadaluarsakan(100, () => Promise.reject(new AppError(404, "NOT_FOUND", "x")))).toBe(0);
    expect(err).not.toHaveBeenCalled();
  });

  test("dua sapuan paralel → tiap pesanan expired tepat sekali (D3)", async () => {
    const codes = [await pesanDulu(s.tCust, s.menu, 2), await pesanDulu(s.tCust, s.menu, 2), await pesanDulu(s.tCust, s.menu, 2)];
    for (const c of codes) await lewat(c);
    const err = vi.spyOn(console, "error");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const [x, y] = await Promise.all([kadaluarsakan(), kadaluarsakan()]);
    expect(x + y).toBe(3);
    expect((await menuRow(s.menu)).held_today).toBe(0);
    expect(await notifKedaluwarsa()).toBe(3);
    expect(await n(
      "SELECT COUNT(*) n FROM order_status_logs l JOIN orders o ON o.id = l.order_id WHERE l.from_status = 'holding' AND l.to_status = 'expired' AND o.code IN (?)",
      [codes],
    )).toBe(3);
    expect(err).not.toHaveBeenCalled();
  });

  test("pesanan toko lain ikut tersapu", async () => {
    const code = await pesanDulu(s.tCust, menuB);
    await lewat(code);
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await kadaluarsakan()).toBe(1);
    expect((await pesanan(code)).status).toBe("expired");
  });
});

describe("mulaiJobKadaluarsa (D2)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("segera saat start, lalu tiap 30 dtk; berhenti setelah stop()", async () => {
    vi.useFakeTimers();
    const sapu = vi.fn().mockResolvedValue(0);
    const stop = mulaiJobKadaluarsa(30_000, sapu);
    await vi.advanceTimersByTimeAsync(0);
    expect(sapu).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sapu).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sapu).toHaveBeenCalledTimes(2);
  });

  test("sapuan yang belum selesai tidak ditumpuk", async () => {
    vi.useFakeTimers();
    const sapu = vi.fn(() => new Promise(() => {}));
    const stop = mulaiJobKadaluarsa(30_000, sapu);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(sapu).toHaveBeenCalledTimes(1);
    stop();
  });

  test("sapuan gagal dicatat dan tik berikutnya tetap jalan", async () => {
    vi.useFakeTimers();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const sapu = vi.fn().mockRejectedValueOnce(new Error("db mati")).mockResolvedValue(0);
    const stop = mulaiJobKadaluarsa(30_000, sapu);
    await vi.advanceTimersByTimeAsync(0);
    expect(err).toHaveBeenCalledWith("[kadaluarsa] sapuan gagal:", "db mati");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sapu).toHaveBeenCalledTimes(2);
    stop();
  });
});
