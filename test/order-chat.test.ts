import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, onTestFinished, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { env } from "../src/config/env";
import { chatLimiter } from "../src/middleware/rate-limiter";
import {
  ChatParty,
  getChatState,
  listMessages,
  loadChatOrder,
  markRead,
  sendMessage,
} from "../src/services/order-chat.service";
import { createCustomer, placeOrder, prepareCheckout } from "./helpers/merchant";

// Chat pesanan sisi pembeli: /orders/:code/messages, kolom `chat` di pesanan pembeli, /me/chats/unread
let setup: Awaited<ReturnType<typeof prepareCheckout>>;
let otherToken: string;
let merchantParty: ChatParty;

const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });
const get = (urlPath: string, token = setup.customerToken) =>
  request(app).get(`/api/v1${urlPath}`).set(authHeader(token));
const post = (urlPath: string, body?: object, token = setup.customerToken) => {
  const req = request(app).post(`/api/v1${urlPath}`).set(authHeader(token));
  return body === undefined ? req : req.send(body);
};
const merchantAction = (code: string, action: string) =>
  request(app).post(`/api/v1/merchant/orders/${code}/${action}`).set(authHeader(setup.tokenA)).expect(200);
// Pesanan Budi yang sudah diterima toko (chat terbuka).
const confirmedOrder = async () => {
  const code = await placeOrder(setup.customerToken, setup.menu);
  await merchantAction(code, "confirm");
  return code;
};
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MESSAGE_KEYS = ["body", "created_at", "id", "image_url", "sender_role"];
const CHAT_KEYS = [
  "available",
  "closed_reason",
  "is_open",
  "other_party_last_read_id",
  "reported_by_me",
  "unread_count",
];

beforeAll(async () => {
  setup = await prepareCheckout();
  otherToken = await createCustomer(1);
  const [[merchant]] = await db.query<any[]>("SELECT user_id FROM merchants WHERE id = ?", [setup.idA]);
  merchantParty = { role: "merchant", merchantId: setup.idA, userId: merchant.user_id };
});
beforeEach(async () => {
  chatLimiter.reset();
  // Batas 3 pesanan menunggu per pembeli: pesanan lama yang masih menunggu dikadaluarsakan.
  await db.query("UPDATE orders SET status = 'expired' WHERE status = 'holding'");
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("migrasi 018_chat_pesanan", () => {
  test("FK: pesan, penanda baca, dan laporan ikut terhapus bersama pesanan; pengirim dihapus → NULL", async () => {
    const [rows] = await db.query<any[]>(
      `SELECT TABLE_NAME AS t, REFERENCED_TABLE_NAME AS ref, DELETE_RULE AS rule_name FROM information_schema.REFERENTIAL_CONSTRAINTS
       WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME IN ('order_messages', 'order_chat_reads', 'order_chat_reports')
       ORDER BY t, ref`,
    );
    expect(rows.map((row: any) => `${row.t}>${row.ref}:${row.rule_name}`)).toEqual([
      "order_chat_reads>orders:CASCADE",
      "order_chat_reports>orders:CASCADE",
      "order_chat_reports>users:SET NULL",
      "order_messages>orders:CASCADE",
      "order_messages>users:SET NULL",
    ]);
  });
});

describe("POST /orders/:code/messages", () => {
  test("holding → 409 CHAT_NOT_OPEN", async () => {
    const code = await placeOrder(setup.customerToken, setup.menu);
    const res = await post(`/orders/${code}/messages`, { body: "Halo" }).expect(409);
    expect(res.body.error).toMatchObject({
      code: "CHAT_NOT_OPEN",
      message: "Chat terbuka setelah penjual menerima pesanan.",
    });
  });

  test("confirmed → 201 ChatMessage, teks dirapikan", async () => {
    const code = await confirmedOrder();
    const res = await post(`/orders/${code}/messages`, { body: "  Saya sudah di titik temu  " }).expect(201);
    expect(Object.keys(res.body.data).sort()).toEqual(MESSAGE_KEYS);
    expect(res.body.data).toMatchObject({ sender_role: "customer", body: "Saya sudah di titik temu", image_url: null });
    expect(typeof res.body.data.id).toBe("number");
    expect(res.body.data.created_at).toMatch(ISO);
  });

  test("pesan kosong, spasi saja, atau lebih dari 1000 karakter → 400", async () => {
    const code = await confirmedOrder();
    for (const body of [{}, { body: "" }, { body: "   " }, { body: "a".repeat(1001) }]) {
      const res = await post(`/orders/${code}/messages`, body).expect(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    }
    await post(`/orders/${code}/messages`, { body: "a".repeat(1000) }).expect(201);
  });

  test("setelah completed: kirim 409 CHAT_CLOSED, GET tetap 200 dan riwayat terbaca", async () => {
    const code = await confirmedOrder();
    await post(`/orders/${code}/messages`, { body: "Masih berapa lama?" }).expect(201);
    for (const action of ["cook", "ready", "complete"]) await merchantAction(code, action);
    const res = await post(`/orders/${code}/messages`, { body: "Terima kasih" }).expect(409);
    expect(res.body.error).toMatchObject({
      code: "CHAT_CLOSED",
      message: "Chat sudah ditutup karena pesanan selesai atau dibatalkan.",
    });
    const list = await get(`/orders/${code}/messages`).expect(200);
    expect(list.body.data.messages.map((message: any) => message.body)).toEqual(["Masih berapa lama?"]);
    expect(list.body.data.chat).toMatchObject({ available: true, is_open: false, closed_reason: "finished" });
  });

  test("pesan ke-31 dalam satu menit → 429 RATE_LIMITED", async () => {
    const code = await confirmedOrder();
    for (let i = 0; i < 30; i++) await post(`/orders/${code}/messages`, { body: `Pesan ${i}` }).expect(201);
    const res = await post(`/orders/${code}/messages`, { body: "Satu lagi" }).expect(429);
    expect(res.body.error).toMatchObject({ code: "RATE_LIMITED", message: "Terlalu banyak pesan. Tunggu sebentar." });
  });

  test("kirim bersamaan dengan penjual menyelesaikan pesanan: 201 atau 409, tidak pernah 500 (deadlock)", async () => {
    for (let round = 0; round < 5; round++) {
      const code = await confirmedOrder();
      for (const action of ["cook", "ready"]) await merchantAction(code, action);
      const [complete, ...sends] = await Promise.all([
        request(app).post(`/api/v1/merchant/orders/${code}/complete`).set(authHeader(setup.tokenA)),
        ...[1, 2, 3, 4].map((i) => post(`/orders/${code}/messages`, { body: `Pesan ${i}` })),
      ]);
      expect(complete.status).toBe(200);
      for (const send of sends) expect([201, 409]).toContain(send.status);
    }
  });
});

describe("GET /orders/:code/messages", () => {
  test("after_id hanya mengembalikan pesan sesudahnya, urut id", async () => {
    const code = await confirmedOrder();
    const ids: number[] = [];
    for (const body of ["Satu", "Dua", "Tiga"])
      ids.push((await post(`/orders/${code}/messages`, { body }).expect(201)).body.data.id);
    await sendMessage(merchantParty, code, { body: "Empat dari penjual" });
    const all = await get(`/orders/${code}/messages`).expect(200);
    expect(all.body.data.messages.map((message: any) => message.body)).toEqual([
      "Satu",
      "Dua",
      "Tiga",
      "Empat dari penjual",
    ]);
    expect(all.body.data.messages[3].sender_role).toBe("merchant");
    expect(Object.keys(all.body.data.chat).sort()).toEqual(CHAT_KEYS);
    const after = await get(`/orders/${code}/messages?after_id=${ids[0]}`).expect(200);
    const afterIds = after.body.data.messages.map((message: any) => message.id);
    expect(afterIds).toEqual([...afterIds].sort((left, right) => left - right));
    expect(after.body.data.messages.map((message: any) => message.body)).toEqual(["Dua", "Tiga", "Empat dari penjual"]);
    const last = all.body.data.messages[3].id;
    expect((await get(`/orders/${code}/messages?after_id=${last}`).expect(200)).body.data.messages).toEqual([]);
  });

  test("after_id bukan bilangan bulat ≥ 0 → 400", async () => {
    const code = await confirmedOrder();
    for (const afterId of ["abc", "-1", "1.5"]) await get(`/orders/${code}/messages?after_id=${afterId}`).expect(400);
  });

  test("pembeli lain → 404 pada GET, POST, dan read; pesan tidak tersimpan", async () => {
    const code = await confirmedOrder();
    for (const res of [
      await get(`/orders/${code}/messages`, otherToken),
      await post(`/orders/${code}/messages`, { body: "Ngintip" }, otherToken),
      await post(`/orders/${code}/messages/read`, undefined, otherToken),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    }
    expect((await get(`/orders/${code}/messages`).expect(200)).body.data.messages).toEqual([]);
  });

  test("penjual 403, tanpa token 401", async () => {
    const code = await confirmedOrder();
    await get(`/orders/${code}/messages`, setup.tokenA).expect(403);
    await post(`/orders/${code}/messages`, { body: "Halo" }, setup.tokenA).expect(403);
    await request(app).get(`/api/v1/orders/${code}/messages`).expect(401);
    await request(app).get("/api/v1/me/chats/unread").expect(401);
  });
});

describe("belum dibaca dan tanda Dibaca", () => {
  test("pesan penjual menambah unread_count dan /me/chats/unread; read mengembalikan ke 0", async () => {
    const code = await confirmedOrder();
    const unreadTotal = async () => (await get("/me/chats/unread").expect(200)).body.data.total as number;
    const startTotal = await unreadTotal();
    const mine = (await post(`/orders/${code}/messages`, { body: "Saya sudah di titik temu" }).expect(201)).body.data;
    expect((await get(`/orders/${code}`).expect(200)).body.data.chat).toEqual({
      available: true,
      is_open: true,
      closed_reason: null,
      unread_count: 0,
      other_party_last_read_id: null,
      reported_by_me: false,
    });

    await sendMessage(merchantParty, code, { body: "Pesanan sudah siap" });
    await sendMessage(merchantParty, code, { body: "Saya di depan gerbang" });
    expect((await get(`/orders/${code}`).expect(200)).body.data.chat.unread_count).toBe(2);
    const listed = (await get("/me/orders?tab=active").expect(200)).body.data.find((order: any) => order.code === code);
    expect(listed.chat.unread_count).toBe(2);
    expect(await unreadTotal()).toBe(startTotal + 2);

    await post(`/orders/${code}/messages/read`).expect(204);
    expect((await get(`/orders/${code}`).expect(200)).body.data.chat.unread_count).toBe(0);
    expect(await unreadTotal()).toBe(startTotal);

    // Tanda "Dibaca" pembeli bergantung pada penanda baca penjual.
    const order = await loadChatOrder(merchantParty, code);
    expect((await getChatState(merchantParty, order)).unread_count).toBe(1);
    await markRead(merchantParty, code);
    const chat = (await get(`/orders/${code}/messages`).expect(200)).body.data.chat;
    // Tanpa last_id penandanya = pesan terakhir pembeli; pesan penjual sendiri tidak ikut ditandai.
    expect(chat.other_party_last_read_id).toBe(mine.id);
  });
});

describe("read dengan last_id", () => {
  test("pesan penjual yang masuk sesudah last_id tetap belum dibaca dan tidak ikut 'Dibaca'", async () => {
    const code = await confirmedOrder();
    const first = await sendMessage(merchantParty, code, { body: "Pesanan sudah siap" });
    const second = await sendMessage(merchantParty, code, { body: "Saya di depan gerbang" });
    await post(`/orders/${code}/messages/read`, { last_id: first.id }).expect(204);
    expect((await get(`/orders/${code}`).expect(200)).body.data.chat.unread_count).toBe(1);
    const order = await loadChatOrder(merchantParty, code);
    const merchantChat = await getChatState(merchantParty, order);
    expect(merchantChat.other_party_last_read_id).toBe(first.id);
    expect(merchantChat.other_party_last_read_id).toBeLessThan(second.id);
    // last_id melebihi pesan terakhir penjual dipotong ke pesan terakhir penjual.
    await post(`/orders/${code}/messages/read`, { last_id: second.id + 1000 }).expect(204);
    expect((await getChatState(merchantParty, order)).other_party_last_read_id).toBe(second.id);
    for (const lastId of [-1, 1.5, "abc"]) await post(`/orders/${code}/messages/read`, { last_id: lastId }).expect(400);
  });
});

describe("pesanan tamu QR meja", () => {
  test("chat.available false dan kirim pesan 409 CHAT_UNAVAILABLE", async () => {
    const savedServerKey = env.MIDTRANS_SERVER_KEY;
    onTestFinished(() => {
      env.MIDTRANS_SERVER_KEY = savedServerKey;
    });
    env.MIDTRANS_SERVER_KEY = undefined;
    await request(app)
      .patch("/api/v1/merchant/profile")
      .set(authHeader(setup.tokenA))
      .send({ dine_in_enabled: true })
      .expect(200);
    const table = await request(app)
      .post("/api/v1/merchant/tables")
      .set(authHeader(setup.tokenA))
      .send({ label: "Meja Chat" })
      .expect(201);
    const guestOrder = await request(app)
      .post(`/api/v1/tables/${table.body.data.token}/orders`)
      .send({ items: [{ menu_id: setup.menu, qty: 1 }], customer_name: "Tamu" })
      .expect(201);
    const code = guestOrder.body.data.code;
    await db.query("UPDATE orders SET status = 'confirmed' WHERE code = ?", [code]);

    const { chat } = await listMessages(merchantParty, code);
    expect(chat).toMatchObject({ available: false, is_open: false, closed_reason: "unavailable" });
    await expect(sendMessage(merchantParty, code, { body: "Halo" })).rejects.toMatchObject({
      status: 409,
      code: "CHAT_UNAVAILABLE",
      message: "Chat tidak tersedia untuk pesanan meja.",
    });
    await get(`/orders/${code}/messages`).expect(404);
  });
});
