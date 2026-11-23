import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import db from "../src/config/db";
import { getWibDate } from "../src/services/merchant-quota.service";
import { withTransaction } from "../src/services/admin-audit.service";
import { AppError } from "../src/utils/errors";
import { transitionOrder } from "../src/services/order-status.service";
import { expireHeldOrders, startExpiryJob, SYSTEM_ACTOR } from "../src/services/order-expiry.service";
import { freezeClock, menuRow, placeOrder, prepareCheckout, insertMenu, makeVisible } from "./helpers/merchant";

// F08 Task 2: job kadaluarsa holding (R-03, X-04, C-21; D2–D7)
let setup: Awaited<ReturnType<typeof prepareCheckout>>;
let budi: number;
let menuB: number;

const pesanan = async (code: string) =>
  ((await db.query<any[]>("SELECT * FROM orders WHERE code = ?", [code]))[0] as any[])[0];
const count = async (sql: string, args: unknown[] = []) =>
  Number(((await db.query<any[]>(sql, args))[0] as any[])[0].n);
const lewat = (code: string, menit = 1) =>
  db.query("UPDATE orders SET hold_until = UTC_TIMESTAMP() - INTERVAL ? MINUTE WHERE code = ?", [menit, code]);
const asli = (code: string) => withTransaction((conn) => transitionOrder(conn, code, "expire", SYSTEM_ACTOR));
const notifKedaluwarsa = () =>
  count("SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND title = 'Pesanan kedaluwarsa'", [budi]);

beforeAll(async () => {
  setup = await prepareCheckout();
  budi = Number(((await db.query<any[]>("SELECT id FROM users WHERE email = 'budi@mail.com'"))[0] as any[])[0].id);
  await makeVisible(setup.idB);
  await db.query("INSERT INTO merchant_pickup_points (merchant_id, pickup_point_id) VALUES (?, 1)", [setup.idB]);
  menuB = await insertMenu(setup.idB);
});
afterEach(async () => {
  vi.restoreAllMocks();
  freezeClock(); // restoreAllMocks juga melepas jam katalog yang dibekukan prepareCheckout
  await db.query("UPDATE orders SET status = 'expired' WHERE status = 'holding'");
  await db.query("UPDATE menus SET held_today = 0, sold_today = 0, sold_total = 0, stock_date = ?", [getWibDate()]);
  await db.query("DELETE FROM notifications");
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("expireHeldOrders (D1, D4, D5)", () => {
  test("kriteria backlog: lewat waktu → expired, stok kembali, notifikasi; panggilan kedua idempoten", async () => {
    const [firstCode, secondCode, thirdCode] = [
      await placeOrder(setup.customerToken, setup.menu, 2),
      await placeOrder(setup.customerToken, setup.menu, 2),
      await placeOrder(setup.customerToken, setup.menu, 2),
    ];
    expect((await menuRow(setup.menu)).held_today).toBe(6);
    await lewat(firstCode);
    await lewat(secondCode);
    expect(await expireHeldOrders()).toBe(2);
    for (const code of [firstCode, secondCode]) {
      expect(await pesanan(code)).toMatchObject({
        status: "expired",
        cancelled_by: "system",
        cancel_reason: "Tidak dikonfirmasi tepat waktu.",
      });
    }
    expect((await pesanan(thirdCode)).status).toBe("holding");
    expect((await menuRow(setup.menu)).held_today).toBe(2);
    expect(await notifKedaluwarsa()).toBe(2);

    expect(await expireHeldOrders()).toBe(0);
    expect((await menuRow(setup.menu)).held_today).toBe(2);
    expect(await notifKedaluwarsa()).toBe(2);
  });

  test("batch & urutan hold_until terlama dulu", async () => {
    const codes = [
      await placeOrder(setup.customerToken, setup.menu),
      await placeOrder(setup.customerToken, setup.menu),
      await placeOrder(setup.customerToken, setup.menu),
    ];
    await lewat(codes[0], 1);
    await lewat(codes[1], 3);
    await lewat(codes[2], 2);
    expect(await expireHeldOrders(1)).toBe(1);
    expect((await pesanan(codes[1])).status).toBe("expired");
    expect((await pesanan(codes[0])).status).toBe("holding");
    expect((await pesanan(codes[2])).status).toBe("holding");
    expect(await expireHeldOrders(2)).toBe(2);
    expect((await pesanan(codes[0])).status).toBe("expired");
  });

  test("satu gagal tidak menghentikan sisanya; log tanpa data pembeli", async () => {
    const codes = [
      await placeOrder(setup.customerToken, setup.menu),
      await placeOrder(setup.customerToken, setup.menu),
      await placeOrder(setup.customerToken, setup.menu),
    ];
    await lewat(codes[0], 3);
    await lewat(codes[1], 2);
    await lewat(codes[2], 1);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const expire = (code: string) => (code === codes[0] ? Promise.reject(new Error("boom")) : asli(code));
    expect(await expireHeldOrders(100, expire)).toBe(2);
    expect((await pesanan(codes[0])).status).toBe("holding");
    expect(err).toHaveBeenCalledTimes(1);
    const teks = String(err.mock.calls[0].join(" "));
    expect(teks).toContain(codes[0]);
    expect(teks).toContain("boom");
    expect(teks).not.toContain("Budi");
    expect(teks).not.toContain("081234567890");
  });

  test("AppError 409/404 dilewati tanpa log galat", async () => {
    const code = await placeOrder(setup.customerToken, setup.menu);
    await lewat(code);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await expireHeldOrders(100, () => Promise.reject(new AppError(409, "CONFLICT", "x")))).toBe(0);
    expect(await expireHeldOrders(100, () => Promise.reject(new AppError(404, "NOT_FOUND", "x")))).toBe(0);
    expect(err).not.toHaveBeenCalled();
  });

  test("dua sapuan paralel → tiap pesanan expired tepat sekali (D3)", async () => {
    const codes = [
      await placeOrder(setup.customerToken, setup.menu, 2),
      await placeOrder(setup.customerToken, setup.menu, 2),
      await placeOrder(setup.customerToken, setup.menu, 2),
    ];
    for (const code of codes) await lewat(code);
    const err = vi.spyOn(console, "error");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const [firstRun, secondRun] = await Promise.all([expireHeldOrders(), expireHeldOrders()]);
    expect(firstRun + secondRun).toBe(3);
    expect((await menuRow(setup.menu)).held_today).toBe(0);
    expect(await notifKedaluwarsa()).toBe(3);
    expect(
      await count(
        "SELECT COUNT(*) n FROM order_status_logs l JOIN orders o ON o.id = l.order_id WHERE l.from_status = 'holding' AND l.to_status = 'expired' AND o.code IN (?)",
        [codes],
      ),
    ).toBe(3);
    expect(err).not.toHaveBeenCalled();
  });

  test("pesanan toko lain ikut tersapu", async () => {
    const code = await placeOrder(setup.customerToken, menuB);
    await lewat(code);
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await expireHeldOrders()).toBe(1);
    expect((await pesanan(code)).status).toBe("expired");
  });
});

describe("startExpiryJob (D2)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("segera saat start, lalu tiap 30 dtk; berhenti setelah stop()", async () => {
    vi.useFakeTimers();
    const sapu = vi.fn().mockResolvedValue(0);
    const stop = startExpiryJob(30_000, sapu);
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
    const stop = startExpiryJob(30_000, sapu);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(sapu).toHaveBeenCalledTimes(1);
    stop();
  });

  test("sapuan gagal dicatat dan tik berikutnya tetap jalan", async () => {
    vi.useFakeTimers();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const sapu = vi.fn().mockRejectedValueOnce(new Error("db mati")).mockResolvedValue(0);
    const stop = startExpiryJob(30_000, sapu);
    await vi.advanceTimersByTimeAsync(0);
    expect(err).toHaveBeenCalledWith("[kadaluarsa] sapuan gagal:", "db mati");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sapu).toHaveBeenCalledTimes(2);
    stop();
  });
});
