// Isi file: handler HTTP notifikasi in-app (pesan di menu Notifikasi aplikasi). Handler membaca query atau isi
// permintaan, memeriksanya dengan skema dto, memanggil notification.service, lalu mengirim JSON. Alurnya
// routes/notification.ts → file ini → services/notification.service.ts → database.
import { Request, RequestHandler } from "express";
import { listNotificationsSchema, markAsReadSchema } from "../dto/notification.dto";
import { bodyObject } from "../dto/order.dto";
import { AuthedRequest } from "../middleware/auth";
import { parse } from "../middleware/validate";
import { listNotifications, markAsRead } from "../services/notification.service";

// id pengguna yang login, sudah dipasang middleware requireAuth di rute.
const getUserId = (req: Request) => (req as AuthedRequest).auth.userId;

/**
 * `GET /me/notifications`: daftar notifikasi milik pengguna yang login, per halaman.
 * @param req permintaan; query diperiksa listNotificationsSchema
 * @param res jawaban `{ data, meta: { page, limit, total, unread_count } }`
 * @returns selesai setelah jawaban dikirim
 * @throws 400 query tidak valid
 */
export const listNotificationsHandler: RequestHandler = async (req, res) => {
  res.json(await listNotifications(getUserId(req), parse(listNotificationsSchema, req.query)));
};

/**
 * `POST /me/notifications/read`: menandai notifikasi sudah dibaca. Isi permintaan yang bukan objek dianggap `{}`
 * sehingga ditolak dengan pesan "Pilih notifikasi yang ditandai."
 * @param req permintaan; isinya `{ ids: [...] }` atau `{ all: true }`, diperiksa markAsReadSchema
 * @param res jawaban `{ data: { unread_count } }`
 * @returns selesai setelah jawaban dikirim
 * @throws 400 isi permintaan tidak valid
 */
export const markAsReadHandler: RequestHandler = async (req, res) => {
  res.json({ data: await markAsRead(getUserId(req), parse(markAsReadSchema, bodyObject(req.body))) });
};
