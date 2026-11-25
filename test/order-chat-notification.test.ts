import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi, type Mock } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { chatLimiter } from "../src/middleware/rate-limiter";
import * as notification from "../src/services/notification.service";
import { sendPushToUser, setPushTransport, type PushMessage, type PushTransport } from "../src/services/push.service";
import { createCustomer, placeOrder, prepareCheckout } from "./helpers/merchant";

// Notifikasi chat: pesan pembeli memberi notifikasi `chat_message` ke penjual, balasan penjual memberi notifikasi
// `chat_message` + push ke pembeli; keduanya digabung per pesanan selama belum dibaca.
let setup: Awaited<ReturnType<typeof prepareCheckout>>;
let merchantUserId: number;
let customerUserId: number;
let otherCustomerToken: string;
let transport: Mock<PushTransport>;
const DEVICE = "fcm-chat";
// Penanda bertipe order_status supaya tidak ikut chatPushes.
const sentinel: PushMessage = { title: "Penanda", body: "-", data: { type: "order_status", order_code: "-" } };

const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });
const post = (urlPath: string, token: string, body?: object) => {
  const req = request(app).post(`/api/v1${urlPath}`).set(authHeader(token));
  return body === undefined ? req : req.send(body);
};
const confirmedOrder = async (token = setup.customerToken) => {
  const code = await placeOrder(token, setup.menu);
  await post(`/merchant/orders/${code}/confirm`, setup.tokenA).expect(200);
  return code;
};
const buyerSends = (code: string, body = "Saya sudah di titik temu") =>
  post(`/orders/${code}/messages`, setup.customerToken, { body }).expect(201);
const merchantReplies = (code: string, body = "Pesanan sudah siap") =>
  post(`/merchant/orders/${code}/messages`, setup.tokenA, { body }).expect(201);
const chatPush = (code: string) => [
  [DEVICE],
  {
    title: "Penjual membalas pesan",
    body: `Penjual membalas pesan di pesanan ${code}.`,
    data: { type: "chat_message", order_code: code },
  },
];
// Push chat saja; push status dari konfirmasi pesanan (confirmedOrder) diabaikan.
const chatPushes = () => transport.mock.calls.filter(([, message]) => message.data.type === "chat_message");
// Push penanda dikirim sesudah aksi: push chat yang dipicu aksi itu (bila ada) sudah masuk lebih dulu.
const chatPushesAfterSentinel = async () => {
  await sendPushToUser(customerUserId, sentinel);
  await vi.waitFor(() => expect(transport).toHaveBeenCalledWith([DEVICE], sentinel));
  return chatPushes();
};
const chatNotifications = async (userId: number) =>
  (
    await db.query<any[]>(
      "SELECT id, title, body, data, read_at, created_at FROM notifications WHERE user_id = ? AND type = 'chat_message' ORDER BY id",
      [userId],
    )
  )[0];

beforeAll(async () => {
  setup = await prepareCheckout();
  const [[merchant]] = await db.query<any[]>("SELECT user_id FROM merchants WHERE id = ?", [setup.idA]);
  merchantUserId = merchant.user_id;
  const [[customer]] = await db.query<any[]>("SELECT id FROM users WHERE email = 'budi@mail.com'");
  customerUserId = customer.id;
  otherCustomerToken = await createCustomer(1);
  await request(app)
    .put("/api/v1/me/push-token")
    .set(authHeader(setup.customerToken))
    .send({ token: DEVICE, platform: "android" })
    .expect(204);
});
beforeEach(async () => {
  chatLimiter.reset();
  // Batas 3 pesanan menunggu per pembeli: pesanan lama yang masih menunggu dikadaluarsakan.
  await db.query("UPDATE orders SET status = 'expired' WHERE status = 'holding'");
  await db.query("DELETE FROM notifications");
  transport = vi.fn<PushTransport>().mockResolvedValue({ invalidTokens: [] });
  setPushTransport(transport);
});
afterAll(() => {
  setPushTransport(null);
  vi.restoreAllMocks();
});

describe("notifikasi chat untuk penjual", () => {
  test("pesan pembeli → satu notifikasi chat_message untuk penjual, tampil di GET /me/notifications", async () => {
    const code = await confirmedOrder();
    await buyerSends(code);
    const rows = await chatNotifications(merchantUserId);
    expect(rows).toHaveLength(1);
    const list = await request(app).get("/api/v1/me/notifications").set(authHeader(setup.tokenA)).expect(200);
    expect(list.body.data).toEqual([
      {
        id: rows[0].id,
        type: "chat_message",
        title: "Pesan baru dari pembeli",
        body: `Pembeli mengirim pesan di pesanan ${code}.`,
        data: { order_code: code },
        read_at: null,
        created_at: expect.any(String),
      },
    ]);
    expect(list.body.meta.unread_count).toBe(1);
    const filtered = await request(app)
      .get("/api/v1/me/notifications?type=chat_message")
      .set(authHeader(setup.tokenA))
      .expect(200);
    expect(filtered.body.data).toEqual(list.body.data);
  });

  test("pesan kedua saat notifikasi belum dibaca → tetap satu baris, created_at maju", async () => {
    const code = await confirmedOrder();
    await buyerSends(code);
    const [first] = await chatNotifications(merchantUserId);
    await db.query("UPDATE notifications SET created_at = '2026-01-01 00:00:00' WHERE id = ?", [first.id]);
    await buyerSends(code, "Saya pakai baju merah");
    const rows = await chatNotifications(merchantUserId);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first.id);
    expect(rows[0].created_at.getTime()).toBeGreaterThan(Date.parse("2026-01-01T00:00:00Z"));
  });

  test("setelah penjual menandai notifikasi dibaca, pesan berikutnya membuat baris baru", async () => {
    const code = await confirmedOrder();
    await buyerSends(code);
    await post("/me/notifications/read", setup.tokenA, { all: true }).expect(200);
    await buyerSends(code, "Halo lagi");
    const rows = await chatNotifications(merchantUserId);
    expect(rows).toHaveLength(2);
    expect(rows[0].read_at).not.toBeNull();
    expect(rows[1].read_at).toBeNull();
  });

  test("pesan pembeli → notifikasi penjual seperti sebelumnya dan tanpa push", async () => {
    const code = await confirmedOrder();
    await buyerSends(code);
    expect(await chatNotifications(merchantUserId)).toHaveLength(1);
    expect(await chatNotifications(customerUserId)).toHaveLength(0);
    expect(await chatPushesAfterSentinel()).toEqual([]);
  });

  test("dua pembeli dari pesanan berbeda di toko yang sama mengirim bersamaan → keduanya 201, dua notifikasi", async () => {
    // Penjual belum punya notifikasi belum dibaca: kedua transaksi sama-sama tidak menemukan baris untuk diperbarui
    // lalu menyisipkan baris baru. Di REPEATABLE READ keduanya saling menunggu kunci celah (deadlock).
    const [codeBudi, codeOther] = await Promise.all([confirmedOrder(), confirmedOrder(otherCustomerToken)]);
    await Promise.all([
      buyerSends(codeBudi),
      post(`/orders/${codeOther}/messages`, otherCustomerToken, { body: "Saya juga sudah sampai" }).expect(201),
    ]);
    const rows = await chatNotifications(merchantUserId);
    expect(rows.map((row: any) => row.data.order_code).sort()).toEqual([codeBudi, codeOther].sort());
  });

  test("penulisan notifikasi gagal → pesan tetap terkirim dan tersimpan, galat dicatat ke log", async () => {
    const code = await confirmedOrder();
    const logError = vi.spyOn(console, "error").mockImplementation(() => {});
    // Tiruan menulis satu baris dulu baru gagal: tulisan setengah jadi itu harus ikut dibatalkan.
    vi.spyOn(notification, "createChatNotification").mockImplementationOnce(async (conn) => {
      await conn.query(
        "INSERT INTO notifications (user_id, type, title, body) VALUES (?, 'chat_message', 'setengah', 'jadi')",
        [merchantUserId],
      );
      throw new Error("gagal tulis notifikasi");
    });
    const sent = await buyerSends(code, "Pesan tetap masuk");
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining("Gagal menyimpan notifikasi chat"),
      "gagal tulis notifikasi",
    );
    logError.mockRestore();
    const [[stored]] = await db.query<any[]>("SELECT body FROM order_messages WHERE id = ?", [sent.body.data.id]);
    expect(stored.body).toBe("Pesan tetap masuk");
    expect(await chatNotifications(merchantUserId)).toHaveLength(0);
  });
});

describe("notifikasi chat untuk pembeli", () => {
  test("penjual membalas → 1 notifikasi chat_message untuk pembeli + 1 push", async () => {
    const code = await confirmedOrder();
    await merchantReplies(code);
    const rows = await chatNotifications(customerUserId);
    expect(rows).toMatchObject([
      {
        title: "Penjual membalas pesan",
        body: `Penjual membalas pesan di pesanan ${code}.`,
        data: { order_code: code },
        read_at: null,
      },
    ]);
    expect(await chatNotifications(merchantUserId)).toHaveLength(0);
    await vi.waitFor(() => expect(chatPushes()).toEqual([chatPush(code)]));
  });

  test("balasan kedua sebelum dibaca → notifikasi dimajukan, tanpa push kedua", async () => {
    const code = await confirmedOrder();
    await merchantReplies(code);
    await vi.waitFor(() => expect(chatPushes()).toHaveLength(1));
    const [first] = await chatNotifications(customerUserId);
    await db.query("UPDATE notifications SET created_at = '2026-01-01 00:00:00' WHERE id = ?", [first.id]);
    await merchantReplies(code, "Sudah di titik temu");
    const rows = await chatNotifications(customerUserId);
    expect(rows).toHaveLength(1);
    expect(rows[0].created_at.getTime()).toBeGreaterThan(Date.parse("2026-01-01T00:00:00Z"));
    expect(await chatPushesAfterSentinel()).toEqual([chatPush(code)]);
  });

  test("pembeli membuka chat (POST read) → notifikasi chat terbaca; balasan berikutnya push lagi", async () => {
    const code = await confirmedOrder();
    await merchantReplies(code);
    await post(`/orders/${code}/messages/read`, setup.customerToken, {}).expect(204);
    expect((await chatNotifications(customerUserId))[0].read_at).not.toBeNull();
    await merchantReplies(code, "Halo lagi");
    const rows = await chatNotifications(customerUserId);
    expect(rows).toHaveLength(2);
    expect(rows[1].read_at).toBeNull();
    await vi.waitFor(() => expect(chatPushes()).toEqual([chatPush(code), chatPush(code)]));
  });
});
