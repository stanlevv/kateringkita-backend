// Isi file: handler HTTP tiket bantuan. Sisi pembeli (/me/tickets) dipasang di routes/ticket.ts dan memanggil
// ticket.service; sisi admin (/admin/tickets, semua tingkat admin) dipasang di routes/admin.ts dan memanggil
// admin-ticket.service. Handler memeriksa query atau isi permintaan dengan skema dto/ticket.dto.ts, lalu mengirim JSON.
import { Request, RequestHandler } from "express";
import { bodyObject } from "../dto/order.dto";
import { replyTicketSchema, createTicketSchema, listAdminTicketsSchema, listTicketsSchema } from "../dto/ticket.dto";
import { AuthedRequest } from "../middleware/auth";
import { parse } from "../middleware/validate";
import { balasTiketAdmin, daftarTiketAdmin, detailTiketAdmin, tutupTiketAdmin } from "../services/admin-ticket.service";
import { getMyTicket, replyMyTicket, createTicket, listMyTickets, closeMyTicket } from "../services/ticket.service";

// id pengguna yang login (pembeli atau admin), sudah dipasang middleware requireAuth di rute.
const getUserId = (req: Request) => (req as AuthedRequest).auth.userId;
const getTicketCode = (req: Request) => String(req.params.code);
// Isi permintaan yang bukan objek (kosong, teks) dianggap {} supaya galatnya tetap per kolom.
const getReplyBody = (req: Request) => parse(replyTicketSchema, bodyObject(req.body)).body;

/**
 * `POST /me/tickets`: pembeli membuat tiket baru beserta pesan pertamanya.
 * @param req permintaan; isinya diperiksa createTicketSchema
 * @param res jawaban 201 `{ data }` berisi detail tiket
 * @returns selesai setelah jawaban dikirim
 * @throws 400 isi tidak valid atau pesanan tidak ditemukan, 409 masih ada 3 tiket belum selesai, 429 terlalu banyak
 *         tiket baru dalam satu jam
 */
export const createTicketHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await createTicket(getUserId(req), parse(createTicketSchema, bodyObject(req.body))) });
};

/**
 * `GET /me/tickets`: daftar tiket milik pembeli per halaman.
 * @param req permintaan; query diperiksa listTicketsSchema
 * @param res jawaban `{ data, meta: { page, limit, total, unread_count } }`
 * @returns selesai setelah jawaban dikirim
 */
export const listMyTicketsHandler: RequestHandler = async (req, res) => {
  res.json(await listMyTickets(getUserId(req), parse(listTicketsSchema, req.query)));
};

/**
 * `GET /me/tickets/:code`: membuka tiket milik pembeli sekaligus menandai balasan admin sudah dibaca.
 * @param req permintaan dengan `:code` tiket
 * @param res jawaban `{ data }` berisi detail tiket
 * @returns selesai setelah jawaban dikirim
 * @throws 404 tiket tidak ada atau milik pembeli lain
 */
export const getMyTicketHandler: RequestHandler = async (req, res) => {
  res.json({ data: await getMyTicket(getUserId(req), getTicketCode(req)) });
};

/**
 * `POST /me/tickets/:code/messages`: pembeli membalas tiketnya.
 * @param req permintaan dengan `:code` tiket; isi `{ body }` diperiksa replyTicketSchema
 * @param res jawaban 201 `{ data }` berisi detail tiket terbaru
 * @returns selesai setelah jawaban dikirim
 * @throws 400 isi tidak valid, 404 tiket tidak ada, 409 tiket sudah ditutup
 */
export const replyMyTicketHandler: RequestHandler = async (req, res) => {
  const body = getReplyBody(req);
  res.status(201).json({ data: await replyMyTicket(getUserId(req), getTicketCode(req), body) });
};

/**
 * `POST /me/tickets/:code/close`: pembeli menutup tiketnya.
 * @param req permintaan dengan `:code` tiket
 * @param res jawaban `{ data }` berisi detail tiket terbaru
 * @returns selesai setelah jawaban dikirim
 * @throws 404 tiket tidak ada atau milik pembeli lain
 */
export const closeMyTicketHandler: RequestHandler = async (req, res) => {
  res.json({ data: await closeMyTicket(getUserId(req), getTicketCode(req)) });
};

/**
 * `GET /admin/tickets`: daftar semua tiket untuk admin, bisa disaring status dan kata cari.
 * @param req permintaan; query diperiksa listAdminTicketsSchema
 * @param res jawaban `{ data, meta }`
 * @returns selesai setelah jawaban dikirim
 * @throws 400 status tidak dikenal atau kata cari terlalu panjang
 */
export const listAdminTicketsHandler: RequestHandler = async (req, res) => {
  res.json(await daftarTiketAdmin(parse(listAdminTicketsSchema, req.query)));
};

/**
 * `GET /admin/tickets/:code`: detail tiket untuk admin (nama pengirim asli, data pembeli, pesanan terkait).
 * @param req permintaan dengan `:code` tiket
 * @param res jawaban `{ data }` berisi detail tiket
 * @returns selesai setelah jawaban dikirim
 * @throws 404 tiket tidak ada
 */
export const getAdminTicketHandler: RequestHandler = async (req, res) => {
  res.json({ data: await detailTiketAdmin(getTicketCode(req)) });
};

/**
 * `POST /admin/tickets/:code/messages`: admin membalas tiket.
 * @param req permintaan dengan `:code` tiket; isi `{ body }` diperiksa replyTicketSchema
 * @param res jawaban 201 `{ data }` berisi detail tiket terbaru
 * @returns selesai setelah jawaban dikirim
 * @throws 400 isi tidak valid, 404 tiket tidak ada, 409 tiket sudah ditutup
 */
export const replyAdminTicketHandler: RequestHandler = async (req, res) => {
  const body = getReplyBody(req);
  res.status(201).json({ data: await balasTiketAdmin(getUserId(req), getTicketCode(req), body) });
};

/**
 * `POST /admin/tickets/:code/close`: admin menutup tiket.
 * @param req permintaan dengan `:code` tiket
 * @param res jawaban `{ data }` berisi detail tiket terbaru
 * @returns selesai setelah jawaban dikirim
 * @throws 404 tiket tidak ada
 */
export const closeAdminTicketHandler: RequestHandler = async (req, res) => {
  res.json({ data: await tutupTiketAdmin(getUserId(req), getTicketCode(req)) });
};
