// Isi file: handler HTTP chat pesanan sisi pembeli (/orders/:code/messages dan /me/chats/unread), dipasang di
// routes/order.ts. Handler memeriksa query atau isi permintaan dengan skema dto/order-chat.dto.ts, memanggil
// order-chat.service sebagai pihak pembeli, lalu mengirim JSON.
import { Request, RequestHandler } from "express";
import { bodyObject } from "../dto/order.dto";
import { listMessagesSchema, sendMessageSchema } from "../dto/order-chat.dto";
import { AuthedRequest } from "../middleware/auth";
import { parse } from "../middleware/validate";
import { ChatParty, countCustomerUnread, listMessages, markRead, sendMessage } from "../services/order-chat.service";

// Pembeli yang login sebagai pihak chat; requireAuth dan requireRole("customer") sudah dipasang di rute.
const getCustomerParty = (req: Request): ChatParty => ({
  role: "customer",
  userId: (req as AuthedRequest).auth.userId,
});
const getOrderCode = (req: Request) => String(req.params.code);

/**
 * `GET /orders/:code/messages?after_id=`: pesan chat pesanan milik pembeli, urut id, beserta keadaan chatnya.
 * @param req permintaan dengan `:code` pesanan; query diperiksa listMessagesSchema
 * @param res jawaban `{ data: { messages, chat } }`
 * @returns selesai setelah jawaban dikirim
 * @throws 400 after_id tidak valid, 404 pesanan tidak ada atau milik pembeli lain
 */
export const listMyOrderMessagesHandler: RequestHandler = async (req, res) => {
  const { after_id: afterId } = parse(listMessagesSchema, req.query);
  res.json({ data: await listMessages(getCustomerParty(req), getOrderCode(req), afterId) });
};

/**
 * `POST /orders/:code/messages`: pembeli mengirim pesan ke penjual.
 * @param req permintaan dengan `:code` pesanan; isi `{ body }` diperiksa sendMessageSchema
 * @param res jawaban 201 `{ data }` berisi pesan yang baru disimpan
 * @returns selesai setelah jawaban dikirim
 * @throws 400 isi tidak valid, 404 pesanan tidak ada, 409 chat belum dibuka, sudah ditutup, atau tidak tersedia,
 *         429 terlalu banyak pesan
 */
export const sendMyOrderMessageHandler: RequestHandler = async (req, res) => {
  const input = parse(sendMessageSchema, bodyObject(req.body));
  res.status(201).json({ data: await sendMessage(getCustomerParty(req), getOrderCode(req), input) });
};

/**
 * `POST /orders/:code/messages/read`: pembeli menandai semua pesan di chat pesanan itu sudah dibaca.
 * @param req permintaan dengan `:code` pesanan
 * @param res jawaban 204 tanpa isi
 * @returns selesai setelah jawaban dikirim
 * @throws 404 pesanan tidak ada atau milik pembeli lain
 */
export const markMyOrderMessagesReadHandler: RequestHandler = async (req, res) => {
  await markRead(getCustomerParty(req), getOrderCode(req));
  res.status(204).end();
};

/**
 * `GET /me/chats/unread`: jumlah pesan penjual yang belum dibaca pembeli di semua pesanannya, untuk badge chat.
 * @param req permintaan dari pembeli yang login
 * @param res jawaban `{ data: { total } }`
 * @returns selesai setelah jawaban dikirim
 */
export const countMyUnreadChatsHandler: RequestHandler = async (req, res) => {
  res.json({ data: { total: await countCustomerUnread((req as AuthedRequest).auth.userId) } });
};
