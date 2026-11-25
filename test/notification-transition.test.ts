import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi, type Mock } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { getWibDate } from "../src/services/merchant-quota.service";
import { withTransaction } from "../src/services/admin-audit.service";
import { expireHeldOrders } from "../src/services/order-expiry.service";
import { sendPushToUser, setPushTransport, type PushMessage, type PushTransport } from "../src/services/push.service";
import { OrderAction, Actor, Status, transitionOrder } from "../src/services/order-status.service";
import { placeOrder, prepareCheckout } from "./helpers/merchant";

// Notifikasi status pesanan dibuat di dalam transaksi transisi
let setup: Awaited<ReturnType<typeof prepareCheckout>>;
let merchant: Actor;
let merchantB: Actor;
let customer: Actor;
let budi: number;
let siti: number;
const system: Actor = { kind: "system" };
const MERCHANT_NAME = "Dapur Siti";

const runTransition = (code: string, action: OrderAction, actor: Actor, reason?: string | null) =>
  withTransaction((conn) => transitionOrder(conn, code, action, actor, reason));
const getNotifications = async (userId = budi) =>
  (await db.query<any[]>("SELECT * FROM notifications WHERE user_id = ? ORDER BY id", [userId]))[0] as any[];
const prepareOrder = async (status: Status = "holding") => {
  const code = await placeOrder(setup.customerToken, setup.menu, 2);
  await db.query("UPDATE orders SET status = ? WHERE code = ?", [status, code]);
  return code;
};
const passHoldDeadline = (code: string) =>
  db.query("UPDATE orders SET hold_until = UTC_TIMESTAMP() - INTERVAL 1 MINUTE WHERE code = ?", [code]);
const merchantAction = (code: string, action: string, body: object = {}) =>
  request(app)
    .post(`/api/v1/merchant/orders/${code}/${action}`)
    .set("Authorization", `Bearer ${setup.tokenA}`)
    .send(body);

beforeAll(async () => {
  setup = await prepareCheckout();
  const id = async (email: string) =>
    Number(((await db.query<any[]>("SELECT id FROM users WHERE email = ?", [email]))[0] as any[])[0].id);
  budi = await id("budi@mail.com");
  siti = await id("siti@mail.com");
  merchant = { kind: "merchant", userId: siti, merchantId: setup.idA };
  merchantB = { kind: "merchant", userId: await id("andi@mail.com"), merchantId: setup.idB };
  customer = { kind: "customer", userId: budi };
});
afterEach(async () => {
  await db.query("UPDATE orders SET status = 'expired' WHERE status = 'holding'");
  await db.query("UPDATE menus SET held_today = 0, sold_today = 0, sold_total = 0, stock_date = ?", [getWibDate()]);
  await db.query("DELETE FROM notifications");
  await db.query("UPDATE merchants SET business_name = ? WHERE id = ?", [MERCHANT_NAME, setup.idA]);
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("notifikasi untuk pembeli", () => {
  test("confirm → cook → ready → complete: tepat 3 notifikasi, complete tanpa notifikasi", async () => {
    const code = await prepareOrder();
    for (const action of ["confirm", "cook", "ready", "complete"] as OrderAction[])
      await runTransition(code, action, merchant);
    const notifications = await getNotifications();
    expect(notifications.map((notification) => notification.title)).toEqual([
      "Pesanan dikonfirmasi",
      "Pesanan sedang dimasak",
      "Pesanan siap diambil",
    ]);
    expect(notifications[0].body).toBe(`${MERCHANT_NAME} sudah mengonfirmasi pesanan ${code}.`);
    expect(notifications[1].body).toBe(`${MERCHANT_NAME} sedang memasak pesanan ${code}.`);
    expect(notifications[2].body).toBe(`Pesanan ${code} sudah siap. Silakan ambil di titik temu.`);
    expect(notifications[0]).toMatchObject({
      type: "order_status",
      data: { order_code: code, status: "confirmed" },
      read_at: null,
    });
    expect(notifications[0].created_at).toBeInstanceOf(Date);
  });

  test("reject: judul & alasan; alasan 255 + nama toko 150 → body dipotong 255", async () => {
    const code = await prepareOrder();
    await runTransition(code, "reject", merchant, "Stok habis");
    expect((await getNotifications())[0]).toMatchObject({
      title: "Pesanan ditolak",
      body: `${MERCHANT_NAME} menolak pesanan ${code}. Alasan: Stok habis`,
    });

    await db.query("UPDATE merchants SET business_name = ? WHERE id = ?", ["T".repeat(150), setup.idA]);
    const code2 = await prepareOrder();
    await expect(runTransition(code2, "reject", merchant, "a".repeat(255))).resolves.toMatchObject({ ke: "cancelled" });
    expect((await getNotifications())[1].body.length).toBe(255);
  });

  test("expire sistem → Pesanan kedaluwarsa", async () => {
    const code = await prepareOrder();
    await passHoldDeadline(code);
    await runTransition(code, "expire", system);
    expect((await getNotifications())[0]).toMatchObject({
      title: "Pesanan kedaluwarsa",
      body: `Pesanan ${code} di ${MERCHANT_NAME} dibatalkan otomatis karena tidak dikonfirmasi tepat waktu.`,
      data: { order_code: code, status: "expired" },
    });
  });

  test("aksi pembeli sendiri (cancel HTTP, complete) tanpa notifikasi", async () => {
    const code = await prepareOrder();
    await request(app)
      .post(`/api/v1/orders/${code}/cancel`)
      .set("Authorization", `Bearer ${setup.customerToken}`)
      .send({})
      .expect(200);
    const code2 = await prepareOrder("ready");
    await runTransition(code2, "complete", customer);
    expect(await getNotifications()).toEqual([]);
  });

  test("transisi gagal → tanpa notifikasi", async () => {
    const code = await prepareOrder();
    await expect(runTransition(code, "cook", merchant)).rejects.toMatchObject({ status: 409 });
    await expect(runTransition(code, "confirm", merchantB)).rejects.toMatchObject({ status: 404 });
    await expect(runTransition(code, "expire", system)).rejects.toMatchObject({ status: 409 });
    await expect(runTransition("KK-TIDAKADA", "expire", system)).rejects.toMatchObject({ status: 404 });
    expect(await getNotifications()).toEqual([]);
  });

  test("tanpa data pembeli; penjual tidak menerima notifikasi", async () => {
    const code = await prepareOrder();
    await runTransition(code, "confirm", merchant);
    const code2 = await prepareOrder();
    await runTransition(code2, "reject", merchant, "Habis");
    const text = JSON.stringify(await getNotifications());
    expect(text).not.toContain("081234567890");
    expect(text).not.toContain("Budi");
    expect(await getNotifications(siti)).toEqual([]);
  });
});

describe("push ke pembeli", () => {
  const DEVICE = "fcm-transisi";
  const sentinel: PushMessage = { title: "Penanda", body: "-", data: { type: "order_status", order_code: "-" } };
  let transport: Mock<PushTransport>;
  beforeAll(async () => {
    await request(app)
      .put("/api/v1/me/push-token")
      .set("Authorization", `Bearer ${setup.customerToken}`)
      .send({ token: DEVICE, platform: "android" })
      .expect(204);
  });
  beforeEach(() => {
    transport = vi.fn<PushTransport>().mockResolvedValue({ invalidTokens: [] });
    setPushTransport(transport);
  });
  afterEach(() => setPushTransport(null));

  test("penjual konfirmasi → push ke pembeli dengan judul 'Pesanan dikonfirmasi' dan data {type:'order_status', order_code}", async () => {
    const code = await prepareOrder();
    await merchantAction(code, "confirm").expect(200);
    await vi.waitFor(() =>
      expect(transport).toHaveBeenCalledWith([DEVICE], {
        title: "Pesanan dikonfirmasi",
        body: `${MERCHANT_NAME} sudah mengonfirmasi pesanan ${code}.`,
        data: { type: "order_status", order_code: code },
      }),
    );
  });

  test("transport melempar → konfirmasi tetap 200 dan notifikasi lonceng tersimpan", async () => {
    const logError = vi.spyOn(console, "error").mockImplementation(() => {});
    transport.mockRejectedValue(new Error("fcm down"));
    const code = await prepareOrder();
    await merchantAction(code, "confirm").expect(200);
    await vi.waitFor(() => expect(logError).toHaveBeenCalledWith("Gagal mengirim push:", expect.any(Error)));
    logError.mockRestore();
    expect(await getNotifications()).toMatchObject([{ title: "Pesanan dikonfirmasi", data: { order_code: code } }]);
  });

  test("kadaluarsa otomatis (expireHeldOrders) → push 'Pesanan kedaluwarsa'", async () => {
    const code = await prepareOrder();
    await passHoldDeadline(code);
    await expireHeldOrders();
    await vi.waitFor(() =>
      expect(transport).toHaveBeenCalledWith(
        [DEVICE],
        expect.objectContaining({ title: "Pesanan kedaluwarsa", data: { type: "order_status", order_code: code } }),
      ),
    );
  });

  test("pembeli membatalkan sendiri → tanpa push", async () => {
    const code = await prepareOrder();
    await request(app)
      .post(`/api/v1/orders/${code}/cancel`)
      .set("Authorization", `Bearer ${setup.customerToken}`)
      .send({})
      .expect(200);
    // Push penanda dikirim sesudahnya: bila pembatalan memicu push, panggilannya sudah masuk lebih dulu.
    await sendPushToUser(budi, sentinel);
    expect(transport.mock.calls).toEqual([[[DEVICE], sentinel]]);
  });
});

// Urutan kunci users → orders untuk semua aktor; tanpa itu INSERT notifikasi (FK users) membentuk siklus dengan checkout/batal pembeli
describe("balapan tanpa deadlock", () => {
  test("tolak penjual paralel dengan checkout pembeli yang sama, 5 putaran → tanpa 500", async () => {
    let rejectedCount = 0;
    for (let i = 0; i < 5; i++) {
      const code = await prepareOrder();
      const [rejectRes, checkoutRes] = await Promise.all([
        merchantAction(code, "reject", { reason: "Habis" }),
        request(app)
          .post("/api/v1/orders")
          .set("Authorization", `Bearer ${setup.customerToken}`)
          .set("Idempotency-Key", crypto.randomUUID())
          .send({ items: [{ menu_id: setup.menu2, qty: 1 }], pickup_point_id: 1, payment_method: "cod" }),
      ]);
      expect([200, 409]).toContain(rejectRes.status);
      expect([201, 409]).toContain(checkoutRes.status);
      if (rejectRes.status === 200) rejectedCount++;
      await db.query("UPDATE orders SET status = 'expired' WHERE status = 'holding'");
    }
    expect((await getNotifications()).filter((notification) => notification.title === "Pesanan ditolak")).toHaveLength(
      rejectedCount,
    );
    expect(rejectedCount).toBe(5);
  });

  test("expire sistem paralel dengan batal pembeli pada pesanan lain, 5 putaran → tanpa 500", async () => {
    for (let i = 0; i < 5; i++) {
      const older = await prepareOrder();
      await passHoldDeadline(older);
      const newer = await prepareOrder();
      const [expireResult, cancelResult] = await Promise.allSettled([
        runTransition(older, "expire", system),
        request(app)
          .post(`/api/v1/orders/${newer}/cancel`)
          .set("Authorization", `Bearer ${setup.customerToken}`)
          .send({}),
      ]);
      expect(expireResult.status).toBe("fulfilled");
      expect(cancelResult.status === "fulfilled" && cancelResult.value.status).toBe(200);
    }
    expect(
      (await getNotifications()).filter((notification) => notification.title === "Pesanan kedaluwarsa"),
    ).toHaveLength(5);
  });
});
