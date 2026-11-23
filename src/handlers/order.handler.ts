// Handler HTTP pesanan pembeli dan pembayarannya. Lapisan kedua alur routes → handlers → services:
// baca parameter/body/header, validasi yang belum dicek di rute, lalu panggil order.service atau pembayaran-va.service.
import { Request, RequestHandler } from "express";
import {
  reasonSchema,
  payOnlineSchema,
  bodyObject,
  myOrdersQuerySchema,
  idempotencyKeySchema,
  orderSchema,
} from "../dto/order.dto";
import { kirimUlasan } from "../services/ulasan.service";
import { AuthedRequest } from "../middleware/auth";
import { parse } from "../middleware/validate";
import {
  getMyOrder,
  cancelMyOrder,
  createOrder,
  listMyOrders,
  reorder,
  quote,
  completeMyOrder,
  getMyOrderWhatsapp,
} from "../services/order.service";
import { bayarOnline, buatQris, buatVa, terimaNotifikasiMidtrans } from "../services/pembayaran-va.service";

const getUserId = (req: Request) => (req as AuthedRequest).auth.userId;

/** `POST /orders/:code/va` (F10): buat Virtual Account Midtrans; body sudah divalidasi vaSchema di rute. */
export const createVaHandler: RequestHandler = async (req, res) => {
  res.json({ data: await buatVa(getUserId(req), String(req.params.code), req.body.bank) });
};

/** `POST /orders/:code/online` (F26): buka halaman bayar Snap. Body opsional (kosong = {}), `kembali` dicek di sini. */
export const payOnlineHandler: RequestHandler = async (req, res) => {
  const { kembali: returnUrl } = parse(payOnlineSchema, bodyObject(req.body));
  res.json({ data: await bayarOnline(getUserId(req), String(req.params.code), returnUrl) });
};

/** `POST /orders/:code/qris`: buat QRIS Midtrans yang digambar langsung di aplikasi; tanpa body. */
export const createQrisHandler: RequestHandler = async (req, res) => {
  res.json({ data: await buatQris(getUserId(req), String(req.params.code)) });
};

/**
 * `POST /payments/midtrans` (F10): terima notifikasi pembayaran Midtrans tanpa token login.
 * Selalu dibalas `{ ok: true }` bila diterima, karena Midtrans mengulang notifikasi sampai dijawab 2xx.
 */
export const midtransNotificationHandler: RequestHandler = async (req, res) => {
  await terimaNotifikasiMidtrans(bodyObject(req.body) as Record<string, unknown>);
  res.json({ data: { ok: true } });
};

/** `POST /orders/quote`: hitung harga, diskon, dan peringatan stok tanpa menyimpan apa pun. */
export const quoteHandler: RequestHandler = async (req, res) => {
  res.json({ data: await quote(getUserId(req), req.body) });
};

/**
 * `POST /orders` (checkout F06): validasi body dengan orderSchema dan header `Idempotency-Key` (UUID, galat di field
 * `idempotency_key`), lalu buat pesanan. Dibalas 201 berisi detail pesanan.
 */
export const createOrderHandler: RequestHandler = async (req, res) => {
  const data = parse(orderSchema, req.body);
  const idempotencyKey = parse(idempotencyKeySchema, req.get("Idempotency-Key"), "idempotency_key");
  res.status(201).json({ data: await createOrder(getUserId(req), idempotencyKey, data) });
};

/** `GET /orders/:code`: detail satu pesanan milik pembeli yang login, termasuk info pembayaran. */
export const getMyOrderHandler: RequestHandler = async (req, res) => {
  res.json({ data: await getMyOrder(getUserId(req), String(req.params.code)) });
};

/** `GET /orders/:code/whatsapp`: tautan wa.me berisi pesan pembeli ke toko untuk pesanan ini. */
export const getMyOrderWhatsappHandler: RequestHandler = async (req, res) => {
  res.json({ data: await getMyOrderWhatsapp(getUserId(req), String(req.params.code)) });
};

/** `GET /me/orders` (C-14): daftar pesanan pembeli per tab; respons berisi `data` dan `meta` halaman. */
export const listMyOrdersHandler: RequestHandler = async (req, res) => {
  res.json(await listMyOrders(getUserId(req), parse(myOrdersQuerySchema, req.query)));
};

/** `POST /orders/:code/cancel` (C-15): batalkan pesanan dengan alasan opsional. */
export const cancelMyOrderHandler: RequestHandler = async (req, res) => {
  const { reason } = parse(reasonSchema, bodyObject(req.body));
  res.json({ data: await cancelMyOrder(getUserId(req), String(req.params.code), reason) });
};

/** `POST /orders/:code/complete` (C-16): pembeli menandai pesanan siap ambil sudah selesai. */
export const completeMyOrderHandler: RequestHandler = async (req, res) => {
  res.json({ data: await completeMyOrder(getUserId(req), String(req.params.code)) });
};

/** `POST /orders/:code/reviews` (F13): ulasan pesanan selesai (body sudah divalidasi reviewSchema di rute), dibalas 201. */
export const createReviewHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await kirimUlasan(getUserId(req), String(req.params.code), req.body) });
};

/** `POST /orders/:code/reorder` (F14): pesan lagi dari pesanan lama; dibalas body checkout siap kirim dan quote-nya. */
export const reorderHandler: RequestHandler = async (req, res) => {
  res.json({ data: await reorder(getUserId(req), String(req.params.code)) });
};
