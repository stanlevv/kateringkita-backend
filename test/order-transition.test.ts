import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import db from "../src/config/db";
import { getWibDate } from "../src/services/merchant-quota.service";
import { withTransaction } from "../src/services/admin-audit.service";
import { OrderAction, Actor, Status, transitionOrder } from "../src/services/order-status.service";
import { menuRow, createCustomer, placeOrder, prepareCheckout } from "./helpers/merchant";

// Mesin status pesanan & stok yang berubah tepat sekali
let setup: Awaited<ReturnType<typeof prepareCheckout>>;
let merchant: Actor;
let merchantB: Actor;
let customer: Actor;
let customerB: Actor;
const system: Actor = { kind: "system" };

const STATUS_CHANGED_MSG = "Pesanan sudah berubah status.";
const EXPIRED_MSG = "Batas waktu pesanan sudah habis.";
const runTransition = (code: string, action: OrderAction, actor: Actor, reason?: string | null) =>
  withTransaction((conn) => transitionOrder(conn, code, action, actor, reason));
const orderRow = async (code: string) =>
  ((await db.query<any[]>("SELECT * FROM orders WHERE code = ?", [code]))[0] as any[])[0];
const log = async (code: string) =>
  (
    await db.query<any[]>(
      "SELECT l.from_status, l.to_status, l.actor_user_id FROM order_status_logs l JOIN orders o ON o.id = l.order_id WHERE o.code = ? ORDER BY l.id",
      [code],
    )
  )[0] as any[];
const getStock = async () => {
  const menu = await menuRow(setup.menu);
  return { held: menu.held_today, sold: menu.sold_today, total: menu.sold_total };
};
// pesanan qty 2 dengan status awal disiapkan lewat SQL
const prepareOrder = async (status: Status = "holding", overrides: Record<string, unknown> = {}) => {
  const code = await placeOrder(setup.customerToken, setup.menu, 2);
  await db.query("UPDATE orders SET ? WHERE code = ?", [{ status, ...overrides }, code]);
  return code;
};
const passHoldDeadline = (code: string) =>
  db.query("UPDATE orders SET hold_until = UTC_TIMESTAMP() - INTERVAL 1 MINUTE WHERE code = ?", [code]);

beforeAll(async () => {
  setup = await prepareCheckout();
  const id = async (email: string) =>
    Number(((await db.query<any[]>("SELECT id FROM users WHERE email = ?", [email]))[0] as any[])[0].id);
  merchant = { kind: "merchant", userId: await id("siti@mail.com"), merchantId: setup.idA };
  merchantB = { kind: "merchant", userId: await id("andi@mail.com"), merchantId: setup.idB };
  customer = { kind: "customer", userId: await id("budi@mail.com") };
  await createCustomer(1);
  customerB = { kind: "customer", userId: await id("pembeli1@mail.com") };
});
// batas 3 holding per pembeli & stok menu dikembalikan agar tiap test mulai bersih
afterEach(async () => {
  await db.query("UPDATE orders SET status = 'expired' WHERE status = 'holding'");
  await db.query(
    "UPDATE menus SET held_today = 0, sold_today = 0, sold_total = 0, deleted_at = NULL, is_active = TRUE, stock_date = ?",
    [getWibDate()],
  );
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("tabel aksi × status asal", () => {
  const VALID_TRANSITIONS: Partial<Record<OrderAction, Partial<Record<Status, Status>>>> = {
    confirm: { holding: "confirmed" },
    cook: { confirmed: "cooking" },
    ready: { cooking: "ready" },
    complete: { ready: "completed" },
    reject: { holding: "cancelled", confirmed: "cancelled" },
    cancel: { holding: "cancelled", confirmed: "cancelled" },
    expire: { holding: "expired" },
  };
  const STATUS: Status[] = ["holding", "confirmed", "cooking", "ready", "completed", "cancelled", "expired"];
  const actor = (action: OrderAction) =>
    action === "cancel" || action === "complete" ? customer : action === "expire" ? system : merchant;
  const transitionCases = (Object.keys(VALID_TRANSITIONS) as OrderAction[]).flatMap((action) =>
    STATUS.map((fromStatus) => [action, fromStatus, VALID_TRANSITIONS[action]?.[fromStatus] ?? null] as const),
  );

  test.each(transitionCases)("%s dari %s → %s", async (action, fromStatus, toStatus) => {
    const code = await prepareOrder(fromStatus);
    if (action === "expire") await passHoldDeadline(code);
    const promise = runTransition(code, action, actor(action), action === "reject" ? "Stok habis" : undefined);
    if (toStatus) {
      await expect(promise).resolves.toMatchObject({ dari: fromStatus, ke: toStatus });
      expect((await orderRow(code)).status).toBe(toStatus);
    } else {
      await expect(promise).rejects.toMatchObject({ status: 409, code: "CONFLICT", message: STATUS_CHANGED_MSG });
      expect((await orderRow(code)).status).toBe(fromStatus);
    }
  });

  test("complete juga sah untuk penjual", async () => {
    const code = await prepareOrder("ready");
    await expect(runTransition(code, "complete", merchant)).resolves.toMatchObject({ ke: "completed" });
  });
});

describe("aktor & kepemilikan", () => {
  test.each([
    ["confirm", "customer"],
    ["cook", "customer"],
    ["reject", "customer"],
    ["cancel", "merchant"],
    ["confirm", "system"],
  ] as const)("%s oleh %s → 409", async (action, actorKind) => {
    const code = await prepareOrder(action === "cook" ? "confirmed" : "holding");
    const actor = actorKind === "customer" ? customer : actorKind === "merchant" ? merchant : system;
    await expect(runTransition(code, action, actor, "x")).rejects.toMatchObject({
      status: 409,
      message: STATUS_CHANGED_MSG,
    });
  });

  test("pembeli B / toko B → 404, status tetap", async () => {
    const code = await prepareOrder("holding");
    await expect(runTransition(code, "cancel", customerB)).rejects.toMatchObject({
      status: 404,
      message: "Pesanan tidak ditemukan.",
    });
    await expect(runTransition(code, "confirm", merchantB)).rejects.toMatchObject({
      status: 404,
      message: "Pesanan tidak ditemukan.",
    });
    await expect(runTransition("KK-00000000-XXXX", "confirm", merchant)).rejects.toMatchObject({ status: 404 });
    expect((await orderRow(code)).status).toBe("holding");
  });
});

describe("pembayaran", () => {
  test("cancel dari confirmed non-tunai → 409", async () => {
    const code = await prepareOrder("confirmed", { payment_method: "online" });
    await expect(runTransition(code, "cancel", customer)).rejects.toMatchObject({
      status: 409,
      message: STATUS_CHANGED_MSG,
    });
  });

  test("confirm online belum lunas → 409 belum dibayar; lunas → sukses", async () => {
    const code = await prepareOrder("holding", { payment_method: "online" });
    await expect(runTransition(code, "confirm", merchant)).rejects.toMatchObject({
      status: 409,
      message: "Pesanan belum dibayar.",
    });
    await db.query("UPDATE orders SET payment_status = 'paid' WHERE code = ?", [code]);
    await expect(runTransition(code, "confirm", merchant)).resolves.toMatchObject({ ke: "confirmed" });
  });
});

describe("lewat waktu", () => {
  test.each(["confirm", "cancel", "reject"] as const)("%s → 409 habis, status & held tetap", async (action) => {
    const code = await prepareOrder("holding");
    await passHoldDeadline(code);
    await expect(
      runTransition(code, action, action === "cancel" ? customer : merchant, "Stok habis"),
    ).rejects.toMatchObject({
      status: 409,
      message: EXPIRED_MSG,
    });
    expect((await orderRow(code)).status).toBe("holding");
    expect((await getStock()).held).toBe(2);
  });

  test("expire → expired oleh sistem, held kembali, log aktor NULL", async () => {
    const code = await prepareOrder("holding");
    await passHoldDeadline(code);
    await runTransition(code, "expire", system);
    const order = await orderRow(code);
    expect(order).toMatchObject({
      status: "expired",
      cancelled_by: "system",
      cancel_reason: "Tidak dikonfirmasi tepat waktu.",
    });
    expect(order.cancelled_at).not.toBeNull();
    expect(await getStock()).toEqual({ held: 0, sold: 0, total: 0 });
    expect((await log(code)).at(-1)).toEqual({ from_status: "holding", to_status: "expired", actor_user_id: null });
  });

  test("expire sebelum lewat → 409", async () => {
    const code = await prepareOrder("holding");
    await expect(runTransition(code, "expire", system)).rejects.toMatchObject({
      status: 409,
      message: STATUS_CHANGED_MSG,
    });
  });
});

describe("kolom & log", () => {
  test("confirm → confirmed_at, log, updated_at bergeser", async () => {
    const code = await prepareOrder("holding");
    await db.query("UPDATE orders SET updated_at = UTC_TIMESTAMP() - INTERVAL 1 HOUR WHERE code = ?", [code]);
    const before = (await orderRow(code)).updated_at.getTime();
    await runTransition(code, "confirm", merchant);
    const order = await orderRow(code);
    expect(order.confirmed_at).not.toBeNull();
    expect(order.updated_at.getTime()).toBeGreaterThan(before);
    expect(await log(code)).toEqual([
      { from_status: null, to_status: "holding", actor_user_id: (customer as { userId: number }).userId },
      { from_status: "holding", to_status: "confirmed", actor_user_id: (merchant as { userId: number }).userId },
    ]);
  });

  test("reject dipangkas → cancel_reason, cancelled_by merchant", async () => {
    const code = await prepareOrder("holding");
    await runTransition(code, "reject", merchant, "  Stok habis  ");
    expect(await orderRow(code)).toMatchObject({
      status: "cancelled",
      cancel_reason: "Stok habis",
      cancelled_by: "merchant",
    });
    expect((await orderRow(code)).cancelled_at).not.toBeNull();
  });

  test("cancel tanpa alasan → NULL, cancelled_by customer", async () => {
    const code = await prepareOrder("holding");
    await runTransition(code, "cancel", customer, "   ");
    expect(await orderRow(code)).toMatchObject({ cancel_reason: null, cancelled_by: "customer" });
  });

  test("complete tunai → paid, completed_at", async () => {
    const code = await prepareOrder("ready");
    await runTransition(code, "complete", customer);
    const order = await orderRow(code);
    expect(order.payment_status).toBe("paid");
    expect(order.completed_at).not.toBeNull();
  });
});

describe("stok, qty 2", () => {
  test("confirm → held −2, sold +2", async () => {
    const code = await prepareOrder("holding");
    await runTransition(code, "confirm", merchant);
    expect(await getStock()).toEqual({ held: 0, sold: 2, total: 2 });
  });

  test("cancel dari holding → held −2", async () => {
    const code = await prepareOrder("holding");
    await runTransition(code, "cancel", customer);
    expect(await getStock()).toEqual({ held: 0, sold: 0, total: 0 });
  });

  test("reject dari confirmed → sold −2, held tetap; cook/ready/complete tidak menyentuh menu", async () => {
    const code = await prepareOrder("holding");
    await runTransition(code, "confirm", merchant);
    const otherOrder = await prepareOrder("holding"); // held 2 milik pesanan lain
    await runTransition(code, "reject", merchant, "Stok habis");
    expect(await getStock()).toEqual({ held: 2, sold: 0, total: 0 });

    await runTransition(otherOrder, "confirm", merchant);
    const before = await getStock();
    await runTransition(otherOrder, "cook", merchant);
    await runTransition(otherOrder, "ready", merchant);
    await runTransition(otherOrder, "complete", merchant);
    expect(await getStock()).toEqual(before);
  });

  test("lintas hari: reject dari confirmed → sold_today hari baru tetap, sold_total −2", async () => {
    const code = await prepareOrder("holding");
    await runTransition(code, "confirm", merchant);
    await db.query(
      "UPDATE menus SET stock_date = DATE_ADD(stock_date, INTERVAL 1 DAY), held_today = 5, sold_today = 1 WHERE id = ?",
      [setup.menu],
    );
    await runTransition(code, "reject", merchant, "Stok habis");
    expect(await getStock()).toEqual({ held: 5, sold: 1, total: 0 });
  });

  test("jepit ≥ 0: sold_today dipaksa 1 → 0", async () => {
    const code = await prepareOrder("holding");
    await runTransition(code, "confirm", merchant);
    await db.query("UPDATE menus SET sold_today = 1, sold_total = 1 WHERE id = ?", [setup.menu]);
    await runTransition(code, "cancel", customer);
    expect(await getStock()).toEqual({ held: 0, sold: 0, total: 0 });
  });

  test("menu terhapus tetap dilepas mode batal", async () => {
    const code = await prepareOrder("holding");
    await runTransition(code, "confirm", merchant);
    await db.query("UPDATE menus SET deleted_at = UTC_TIMESTAMP(), is_active = FALSE WHERE id = ?", [setup.menu]);
    await runTransition(code, "reject", merchant, "Stok habis");
    expect(await getStock()).toEqual({ held: 0, sold: 0, total: 0 });
  });
});
