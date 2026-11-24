// Isi file: handler HTTP chat pesanan. Handler chat yang sama dipasang untuk pembeli (routes/order.ts:
// /orders/:code/…, /me/chats/unread) dan penjual (routes/merchant.ts: /merchant/orders/:code/…,
// /merchant/chats/unread); pihaknya ditentukan dari peran akun yang login. Ditambah handler baca laporan chat untuk
// admin (routes/admin.ts: /admin/chat-reports). Handler memeriksa query atau isi permintaan dengan skema
// dto/order-chat.dto.ts, memanggil order-chat.service, lalu mengirim JSON.
import { Request, RequestHandler } from "express";
import { bodyObject } from "../dto/order.dto";
import {
  listChatReportsSchema,
  listMessagesSchema,
  markReadSchema,
  reportChatSchema,
  sendMessageSchema,
} from "../dto/order-chat.dto";
import { AuthedRequest } from "../middleware/auth";
import { parse } from "../middleware/validate";
import { getMerchantId } from "../services/merchant-menu.service";
import {
  ChatParty,
  getChatReport,
  listChatReports,
  listMessages,
  listUnreadChats,
  markRead,
  reportChat,
  requestChatUpload,
  sendMessage,
} from "../services/order-chat.service";

// Pihak chat dari akun yang login. Rute sudah membatasi peran (pembeli di routes/order.ts, penjual di
// routes/merchant.ts); toko penjual selalu dicari dari akunnya, tidak pernah dari isi permintaan.
const getParty = async (req: Request): Promise<ChatParty> => {
  const { userId, role } = (req as AuthedRequest).auth;
  return role === "merchant" ? { role, merchantId: await getMerchantId(userId), userId } : { role: "customer", userId };
};
const getOrderCode = (req: Request) => String(req.params.code);

/**
 * `GET …/orders/:code/messages?after_id=`: pesan chat pesanan milik pihak yang login, urut id, beserta keadaan chatnya.
 * @param req permintaan dengan `:code` pesanan; query diperiksa listMessagesSchema
 * @param res jawaban `{ data: { messages, chat } }`
 * @returns selesai setelah jawaban dikirim
 * @throws 400 after_id tidak valid, 404 pesanan tidak ada atau milik pihak lain
 */
export const listMyOrderMessagesHandler: RequestHandler = async (req, res) => {
  const { after_id: afterId } = parse(listMessagesSchema, req.query);
  res.json({ data: await listMessages(await getParty(req), getOrderCode(req), afterId) });
};

/**
 * `POST …/orders/:code/messages`: mengirim pesan teks dan/atau foto ke pihak lawan.
 * @param req permintaan dengan `:code` pesanan; isi `{ body?, image_url? }` diperiksa sendMessageSchema
 * @param res jawaban 201 `{ data }` berisi pesan yang baru disimpan
 * @returns selesai setelah jawaban dikirim
 * @throws 400 isi atau foto tidak valid, 404 pesanan tidak ada, 409 chat belum dibuka, sudah ditutup, atau tidak
 *         tersedia, 429 terlalu banyak pesan
 */
export const sendMyOrderMessageHandler: RequestHandler = async (req, res) => {
  const input = parse(sendMessageSchema, bodyObject(req.body));
  res.status(201).json({ data: await sendMessage(await getParty(req), getOrderCode(req), input) });
};

/**
 * `POST …/orders/:code/messages/read`: menandai pesan di chat pesanan itu sudah dibaca, sampai `last_id` bila diisi.
 * @param req permintaan dengan `:code` pesanan; isi opsional `{ last_id }` diperiksa markReadSchema
 * @param res jawaban 204 tanpa isi
 * @returns selesai setelah jawaban dikirim
 * @throws 400 last_id tidak valid, 404 pesanan tidak ada atau milik pihak lain
 */
export const markMyOrderMessagesReadHandler: RequestHandler = async (req, res) => {
  const { last_id: lastId } = parse(markReadSchema, bodyObject(req.body));
  await markRead(await getParty(req), getOrderCode(req), lastId);
  res.status(204).end();
};

/**
 * `POST …/orders/:code/messages/upload`: meminta alamat unggah foto chat (folder `orders/<id pesanan>/chat/`).
 * @param req permintaan dengan `:code` pesanan; isi `{ content_type, size }` sudah lolos uploadSchema di rute
 * @param res jawaban `{ data: { upload_url, public_url, expires_at } }`
 * @returns selesai setelah jawaban dikirim
 * @throws 404 pesanan tidak ada atau milik pihak lain, 409 chat tidak terbuka, 503 unggah foto belum diatur
 */
export const requestChatUploadHandler: RequestHandler = async (req, res) => {
  res.json({ data: await requestChatUpload(await getParty(req), getOrderCode(req), req.body) });
};

/**
 * `POST …/orders/:code/chat-report`: melaporkan chat pesanan ke admin.
 * @param req permintaan dengan `:code` pesanan; isi `{ reason }` diperiksa reportChatSchema
 * @param res jawaban 201 `{ data: { id, reporter_role, reason, created_at } }`
 * @returns selesai setelah jawaban dikirim
 * @throws 400 alasan tidak valid, 404 pesanan tidak ada atau milik pihak lain, 409 sudah dilaporkan atau pesanan meja
 */
export const reportChatHandler: RequestHandler = async (req, res) => {
  const { reason } = parse(reportChatSchema, bodyObject(req.body));
  res.status(201).json({ data: await reportChat(await getParty(req), getOrderCode(req), reason) });
};

/**
 * `GET /me/chats/unread`: jumlah pesan penjual yang belum dibaca pembeli di semua pesanannya, untuk badge chat.
 * @param req permintaan dari pembeli yang login
 * @param res jawaban `{ data: { total } }`
 * @returns selesai setelah jawaban dikirim
 */
export const countMyUnreadChatsHandler: RequestHandler = async (req, res) => {
  res.json({ data: { total: (await listUnreadChats(await getParty(req))).total } });
};

/**
 * `GET /merchant/chats/unread`: pesanan toko yang punya pesan pembeli belum dibaca, untuk badge dan daftar chat masuk.
 * @param req permintaan dari penjual yang login
 * @param res jawaban `{ data: { total, orders: [{ code, unread_count, last_message_at }] } }`
 * @returns selesai setelah jawaban dikirim
 * @throws 404 akun ini belum punya toko
 */
export const listMerchantUnreadChatsHandler: RequestHandler = async (req, res) => {
  res.json({ data: await listUnreadChats(await getParty(req)) });
};

/**
 * `GET /admin/chat-reports`: daftar laporan chat untuk admin, terbaru dulu.
 * @param req permintaan; query `page` dan `limit` diperiksa listChatReportsSchema
 * @param res jawaban `{ data, meta: { page, limit, total } }`
 * @returns selesai setelah jawaban dikirim
 */
export const listChatReportsHandler: RequestHandler = async (req, res) => {
  res.json(await listChatReports(parse(listChatReportsSchema, req.query)));
};

/**
 * `GET /admin/chat-reports/:id`: satu laporan chat beserta seluruh pesan pesanan itu (hanya baca).
 * @param req permintaan dengan `:id` laporan
 * @param res jawaban `{ data }` berisi laporan dan `messages`
 * @returns selesai setelah jawaban dikirim
 * @throws 404 laporan tidak ada
 */
export const getChatReportHandler: RequestHandler = async (req, res) => {
  res.json({ data: await getChatReport(Number(req.params.id)) });
};
