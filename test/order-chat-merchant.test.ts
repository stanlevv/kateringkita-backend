import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { chatLimiter, uploadLimiter } from "../src/middleware/rate-limiter";
import { photoUrl, placeOrder, prepareCheckout, setR2Env } from "./helpers/merchant";

// Chat pesanan sisi penjual (/merchant/orders/:code/messages…, /merchant/chats/unread), foto chat dari kedua sisi,
// dan kolom chat_unread_count di pesanan penjual.
let setup: Awaited<ReturnType<typeof prepareCheckout>>;

const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });
const get = (urlPath: string, token: string) => request(app).get(`/api/v1${urlPath}`).set(authHeader(token));
const post = (urlPath: string, token: string, body?: object) => {
  const req = request(app).post(`/api/v1${urlPath}`).set(authHeader(token));
  return body === undefined ? req : req.send(body);
};
const merchantAction = (code: string, action: string) =>
  post(`/merchant/orders/${code}/${action}`, setup.tokenA).expect(200);
const confirmedOrder = async () => {
  const code = await placeOrder(setup.customerToken, setup.menu);
  await merchantAction(code, "confirm");
  return code;
};
const orderId = async (code: string) =>
  ((await db.query<any[]>("SELECT id FROM orders WHERE code = ?", [code]))[0] as any[])[0].id as number;
const chatFolder = async (code: string) => `orders/${await orderId(code)}/chat/`;
const UPLOAD_INPUT = { content_type: "image/jpeg", size: 1000 };

beforeAll(async () => {
  setup = await prepareCheckout();
});
beforeEach(async () => {
  chatLimiter.reset();
  uploadLimiter.reset();
  setR2Env();
  // Batas 3 pesanan menunggu per pembeli: pesanan lama yang masih menunggu dikadaluarsakan.
  await db.query("UPDATE orders SET status = 'expired' WHERE status = 'holding'");
});
afterEach(() => {
  setR2Env(false);
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("chat penjual", () => {
  test("penjual pemilik bisa GET dan POST; pesan cepat tersimpan sebagai merchant", async () => {
    const code = await confirmedOrder();
    await post(`/orders/${code}/messages`, setup.customerToken, { body: "Saya sudah di titik temu" }).expect(201);
    const sent = await post(`/merchant/orders/${code}/messages`, setup.tokenA, { body: "Pesanan sudah siap" }).expect(
      201,
    );
    expect(sent.body.data).toMatchObject({ sender_role: "merchant", body: "Pesanan sudah siap", image_url: null });
    const list = await get(`/merchant/orders/${code}/messages`, setup.tokenA).expect(200);
    expect(list.body.data.messages.map((message: any) => [message.sender_role, message.body])).toEqual([
      ["customer", "Saya sudah di titik temu"],
      ["merchant", "Pesanan sudah siap"],
    ]);
    expect(list.body.data.chat).toMatchObject({ is_open: true, unread_count: 1, reported_by_me: false });
    const customerView = await get(`/orders/${code}/messages`, setup.customerToken).expect(200);
    expect(customerView.body.data.messages[1].sender_role).toBe("merchant");
  });

  test("penjual toko lain → 404 di semua rute chat; tidak ada pesan tersimpan", async () => {
    const code = await confirmedOrder();
    for (const res of [
      await get(`/merchant/orders/${code}/messages`, setup.tokenB),
      await post(`/merchant/orders/${code}/messages`, setup.tokenB, { body: "Ngintip" }),
      await post(`/merchant/orders/${code}/messages/read`, setup.tokenB),
      await post(`/merchant/orders/${code}/messages/upload`, setup.tokenB, UPLOAD_INPUT),
      await post(`/merchant/orders/${code}/chat-report`, setup.tokenB, { reason: "Pembeli kasar" }),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    }
    expect((await get(`/merchant/orders/${code}/messages`, setup.tokenA).expect(200)).body.data.messages).toEqual([]);
  });

  test("pembeli 403 di rute chat penjual", async () => {
    const code = await confirmedOrder();
    await get(`/merchant/orders/${code}/messages`, setup.customerToken).expect(403);
    await get("/merchant/chats/unread", setup.customerToken).expect(403);
  });

  test("holding → 409 CHAT_NOT_OPEN dari sisi penjual", async () => {
    const code = await placeOrder(setup.customerToken, setup.menu);
    const res = await post(`/merchant/orders/${code}/messages`, setup.tokenA, { body: "Halo" }).expect(409);
    expect(res.body.error.code).toBe("CHAT_NOT_OPEN");
  });

  test("/merchant/chats/unread menghitung pesan pembeli yang belum dibaca; read mengosongkan", async () => {
    await db.query("DELETE FROM order_messages");
    const first = await confirmedOrder();
    const second = await confirmedOrder();
    for (const body of ["Satu", "Dua"]) await post(`/orders/${first}/messages`, setup.customerToken, { body });
    await post(`/orders/${second}/messages`, setup.customerToken, { body: "Tiga" });
    await post(`/merchant/orders/${second}/messages`, setup.tokenA, { body: "Pesanan sudah siap" });

    const unread = (await get("/merchant/chats/unread", setup.tokenA).expect(200)).body.data;
    expect(Object.keys(unread).sort()).toEqual(["orders", "total"]);
    expect(unread.total).toBe(3);
    expect(unread.orders.map((order: any) => [order.code, order.unread_count]).sort()).toEqual(
      [
        [first, 2],
        [second, 1],
      ].sort(),
    );
    for (const order of unread.orders) {
      expect(Object.keys(order).sort()).toEqual(["code", "last_message_at", "unread_count"]);
      expect(order.last_message_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
    expect((await get("/merchant/chats/unread", setup.tokenB).expect(200)).body.data).toEqual({ total: 0, orders: [] });

    await post(`/merchant/orders/${first}/messages/read`, setup.tokenA).expect(204);
    const afterRead = (await get("/merchant/chats/unread", setup.tokenA).expect(200)).body.data;
    expect(afterRead).toMatchObject({ total: 1, orders: [{ code: second, unread_count: 1 }] });
  });

  test("chat_unread_count di daftar dan detail pesanan penjual", async () => {
    const code = await confirmedOrder();
    await post(`/orders/${code}/messages`, setup.customerToken, { body: "Masih berapa lama?" });
    const detail = (await get(`/merchant/orders/${code}`, setup.tokenA).expect(200)).body.data;
    expect(detail.chat_unread_count).toBe(1);
    const listed = (await get("/merchant/orders", setup.tokenA).expect(200)).body.data.find(
      (order: any) => order.code === code,
    );
    expect(listed.chat_unread_count).toBe(1);
    await post(`/merchant/orders/${code}/messages/read`, setup.tokenA).expect(204);
    expect((await get(`/merchant/orders/${code}`, setup.tokenA).expect(200)).body.data.chat_unread_count).toBe(0);
  });

  test("read dengan last_id: pesan pembeli sesudah last_id tetap belum dibaca dan tidak ikut 'Dibaca'", async () => {
    const code = await confirmedOrder();
    const first = (await post(`/orders/${code}/messages`, setup.customerToken, { body: "Satu" })).body.data;
    await post(`/orders/${code}/messages`, setup.customerToken, { body: "Dua" });
    await post(`/merchant/orders/${code}/messages/read`, setup.tokenA, { last_id: first.id }).expect(204);
    expect((await get(`/merchant/orders/${code}`, setup.tokenA).expect(200)).body.data.chat_unread_count).toBe(1);
    const customerChat = (await get(`/orders/${code}/messages`, setup.customerToken).expect(200)).body.data.chat;
    expect(customerChat.other_party_last_read_id).toBe(first.id);
    // Penanda tidak pernah mundur.
    await post(`/merchant/orders/${code}/messages/read`, setup.tokenA).expect(204);
    await post(`/merchant/orders/${code}/messages/read`, setup.tokenA, { last_id: first.id }).expect(204);
    expect((await get(`/merchant/orders/${code}`, setup.tokenA).expect(200)).body.data.chat_unread_count).toBe(0);
    await post(`/merchant/orders/${code}/messages/read`, setup.tokenA, { last_id: "abc" }).expect(400);
  });
});

describe("foto chat", () => {
  test("upload pembeli dan penjual → URL di folder orders/<id>/chat/", async () => {
    const code = await confirmedOrder();
    const folder = await chatFolder(code);
    for (const [urlPath, token] of [
      [`/orders/${code}/messages/upload`, setup.customerToken],
      [`/merchant/orders/${code}/messages/upload`, setup.tokenA],
    ]) {
      const res = await post(urlPath, token, UPLOAD_INPUT).expect(200);
      expect(Object.keys(res.body.data).sort()).toEqual(["expires_at", "public_url", "upload_url"]);
      expect(res.body.data.public_url).toMatch(new RegExp(`/${folder}[0-9a-f-]{36}\\.jpg$`));
    }
  });

  test("upload: isi tidak valid 400; chat belum dibuka atau sudah ditutup 409", async () => {
    const code = await confirmedOrder();
    await post(`/orders/${code}/messages/upload`, setup.customerToken, { content_type: "image/gif", size: 1 }).expect(
      400,
    );
    const holding = await placeOrder(setup.customerToken, setup.menu);
    const notOpen = await post(`/orders/${holding}/messages/upload`, setup.customerToken, UPLOAD_INPUT).expect(409);
    expect(notOpen.body.error.code).toBe("CHAT_NOT_OPEN");
    for (const action of ["cook", "ready", "complete"]) await merchantAction(code, action);
    for (const [urlPath, token] of [
      [`/orders/${code}/messages/upload`, setup.customerToken],
      [`/merchant/orders/${code}/messages/upload`, setup.tokenA],
    ]) {
      const res = await post(urlPath, token, UPLOAD_INPUT).expect(409);
      expect(res.body.error.code).toBe("CHAT_CLOSED");
    }
  });

  test("pesan hanya foto sah diterima dari kedua sisi; foto pesanan lain atau domain lain 400", async () => {
    const code = await confirmedOrder();
    const other = await confirmedOrder();
    const folder = await chatFolder(code);
    const customerPhoto = photoUrl(folder);
    const sent = await post(`/orders/${code}/messages`, setup.customerToken, { image_url: customerPhoto }).expect(201);
    expect(sent.body.data).toMatchObject({ sender_role: "customer", body: null, image_url: customerPhoto });
    const merchantPhoto = photoUrl(folder, "webp");
    const reply = await post(`/merchant/orders/${code}/messages`, setup.tokenA, {
      body: "Ini mejanya",
      image_url: merchantPhoto,
    }).expect(201);
    expect(reply.body.data).toMatchObject({ body: "Ini mejanya", image_url: merchantPhoto });

    for (const badUrl of [
      photoUrl(await chatFolder(other)),
      `https://lain.test/${folder}${customerPhoto.split("/").pop()}`,
      photoUrl(`merchants/${setup.idA}/menu/`),
    ]) {
      for (const [urlPath, token] of [
        [`/orders/${code}/messages`, setup.customerToken],
        [`/merchant/orders/${code}/messages`, setup.tokenA],
      ]) {
        const res = await post(urlPath, token, { body: "Foto", image_url: badUrl }).expect(400);
        expect(res.body.error.fields.image_url).toEqual(["Foto tidak valid. Unggah ulang foto."]);
      }
    }
    // Tanpa teks dan tanpa foto tetap ditolak.
    await post(`/orders/${code}/messages`, setup.customerToken, { body: "  ", image_url: null }).expect(400);
    const messages = (await get(`/orders/${code}/messages`, setup.customerToken).expect(200)).body.data.messages;
    expect(messages).toHaveLength(2);
  });
});
