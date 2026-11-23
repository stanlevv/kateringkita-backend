import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import db from "../src/config/db";
import { getWibDate } from "../src/services/merchant-quota.service";
import { withTransaction } from "../src/services/admin-audit.service";
import { AppError } from "../src/utils/errors";
import { transitionOrder } from "../src/services/order-status.service";
import { expireHeldOrders, startExpiryJob, SYSTEM_ACTOR } from "../src/services/order-expiry.service";
import { freezeClock, menuRow, placeOrder, prepareCheckout, insertMenu, makeVisible } from "./helpers/merchant";

// Job kadaluarsa pesanan holding yang belum dibayar
let setup: Awaited<ReturnType<typeof prepareCheckout>>;
let budi: number;
let menuB: number;

const orderRow = async (code: string) =>
  ((await db.query<any[]>("SELECT * FROM orders WHERE code = ?", [code]))[0] as any[])[0];
const count = async (sql: string, args: unknown[] = []) =>
  Number(((await db.query<any[]>(sql, args))[0] as any[])[0].n);
const passHoldDeadline = (code: string, minutes = 1) =>
  db.query("UPDATE orders SET hold_until = UTC_TIMESTAMP() - INTERVAL ? MINUTE WHERE code = ?", [minutes, code]);
const expireDirectly = (code: string) => withTransaction((conn) => transitionOrder(conn, code, "expire", SYSTEM_ACTOR));
const expiryNotifications = () =>
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

describe("expireHeldOrders", () => {
  test("kriteria backlog: lewat waktu → expired, stok kembali, notifikasi; panggilan kedua idempoten", async () => {
    const [firstCode, secondCode, thirdCode] = [
      await placeOrder(setup.customerToken, setup.menu, 2),
      await placeOrder(setup.customerToken, setup.menu, 2),
      await placeOrder(setup.customerToken, setup.menu, 2),
    ];
    expect((await menuRow(setup.menu)).held_today).toBe(6);
    await passHoldDeadline(firstCode);
    await passHoldDeadline(secondCode);
    expect(await expireHeldOrders()).toBe(2);
    for (const code of [firstCode, secondCode]) {
      expect(await orderRow(code)).toMatchObject({
        status: "expired",
        cancelled_by: "system",
        cancel_reason: "Tidak dikonfirmasi tepat waktu.",
      });
    }
    expect((await orderRow(thirdCode)).status).toBe("holding");
    expect((await menuRow(setup.menu)).held_today).toBe(2);
    expect(await expiryNotifications()).toBe(2);

    expect(await expireHeldOrders()).toBe(0);
    expect((await menuRow(setup.menu)).held_today).toBe(2);
    expect(await expiryNotifications()).toBe(2);
  });

  test("batch & urutan hold_until terlama dulu", async () => {
    const codes = [
      await placeOrder(setup.customerToken, setup.menu),
      await placeOrder(setup.customerToken, setup.menu),
      await placeOrder(setup.customerToken, setup.menu),
    ];
    await passHoldDeadline(codes[0], 1);
    await passHoldDeadline(codes[1], 3);
    await passHoldDeadline(codes[2], 2);
    expect(await expireHeldOrders(1)).toBe(1);
    expect((await orderRow(codes[1])).status).toBe("expired");
    expect((await orderRow(codes[0])).status).toBe("holding");
    expect((await orderRow(codes[2])).status).toBe("holding");
    expect(await expireHeldOrders(2)).toBe(2);
    expect((await orderRow(codes[0])).status).toBe("expired");
  });

  test("satu gagal tidak menghentikan sisanya; log tanpa data pembeli", async () => {
    const codes = [
      await placeOrder(setup.customerToken, setup.menu),
      await placeOrder(setup.customerToken, setup.menu),
      await placeOrder(setup.customerToken, setup.menu),
    ];
    await passHoldDeadline(codes[0], 3);
    await passHoldDeadline(codes[1], 2);
    await passHoldDeadline(codes[2], 1);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const expire = (code: string) => (code === codes[0] ? Promise.reject(new Error("boom")) : expireDirectly(code));
    expect(await expireHeldOrders(100, expire)).toBe(2);
    expect((await orderRow(codes[0])).status).toBe("holding");
    expect(err).toHaveBeenCalledTimes(1);
    const logged = String(err.mock.calls[0].join(" "));
    expect(logged).toContain(codes[0]);
    expect(logged).toContain("boom");
    expect(logged).not.toContain("Budi");
    expect(logged).not.toContain("081234567890");
  });

  test("AppError 409/404 dilewati tanpa log galat", async () => {
    const code = await placeOrder(setup.customerToken, setup.menu);
    await passHoldDeadline(code);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await expireHeldOrders(100, () => Promise.reject(new AppError(409, "CONFLICT", "x")))).toBe(0);
    expect(await expireHeldOrders(100, () => Promise.reject(new AppError(404, "NOT_FOUND", "x")))).toBe(0);
    expect(err).not.toHaveBeenCalled();
  });

  test("dua sapuan paralel → tiap pesanan expired tepat sekali", async () => {
    const codes = [
      await placeOrder(setup.customerToken, setup.menu, 2),
      await placeOrder(setup.customerToken, setup.menu, 2),
      await placeOrder(setup.customerToken, setup.menu, 2),
    ];
    for (const code of codes) await passHoldDeadline(code);
    const err = vi.spyOn(console, "error");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const [firstRun, secondRun] = await Promise.all([expireHeldOrders(), expireHeldOrders()]);
    expect(firstRun + secondRun).toBe(3);
    expect((await menuRow(setup.menu)).held_today).toBe(0);
    expect(await expiryNotifications()).toBe(3);
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
    await passHoldDeadline(code);
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await expireHeldOrders()).toBe(1);
    expect((await orderRow(code)).status).toBe("expired");
  });
});

describe("startExpiryJob", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("segera saat start, lalu tiap 30 dtk; berhenti setelah stop()", async () => {
    vi.useFakeTimers();
    const sweep = vi.fn().mockResolvedValue(0);
    const stop = startExpiryJob(30_000, sweep);
    await vi.advanceTimersByTimeAsync(0);
    expect(sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sweep).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  test("sapuan yang belum selesai tidak ditumpuk", async () => {
    vi.useFakeTimers();
    const sweep = vi.fn(() => new Promise(() => {}));
    const stop = startExpiryJob(30_000, sweep);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(sweep).toHaveBeenCalledTimes(1);
    stop();
  });

  test("sapuan gagal dicatat dan tik berikutnya tetap jalan", async () => {
    vi.useFakeTimers();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const sweep = vi.fn().mockRejectedValueOnce(new Error("db mati")).mockResolvedValue(0);
    const stop = startExpiryJob(30_000, sweep);
    await vi.advanceTimersByTimeAsync(0);
    expect(err).toHaveBeenCalledWith("[kadaluarsa] sapuan gagal:", "db mati");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sweep).toHaveBeenCalledTimes(2);
    stop();
  });
});
