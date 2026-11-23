// Isi file: handler HTTP untuk pesanan pembeli dan pembayarannya. Lapisan kedua dari alur routes → handlers →
// services → database: membaca alamat, isi, dan header permintaan, memeriksa yang belum diperiksa di rute, lalu
// memanggil order.service atau pembayaran-va.service dan mengirim jawabannya sebagai JSON.
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

// id pengguna yang login, sudah dipasang middleware requireAuth di rute.
const getUserId = (req: Request) => (req as AuthedRequest).auth.userId;

/**
 * `POST /orders/:code/va`: membuat Virtual Account (nomor rekening sementara untuk transfer bank) lewat Midtrans
 * untuk pesanan ini. Isi permintaan (bank pilihan) sudah diperiksa vaSchema di rute.
 */
export const createVaHandler: RequestHandler = async (req, res) => {
  res.json({ data: await buatVa(getUserId(req), String(req.params.code), req.body.bank) });
};

/**
 * `POST /orders/:code/online`: membuka halaman bayar online Midtrans Snap. Isi permintaan boleh kosong; `kembali`
 * (alamat web setelah bayar) diperiksa di sini.
 */
export const payOnlineHandler: RequestHandler = async (req, res) => {
  const { kembali: returnUrl } = parse(payOnlineSchema, bodyObject(req.body));
  res.json({ data: await bayarOnline(getUserId(req), String(req.params.code), returnUrl) });
};

/** `POST /orders/:code/qris`: membuat kode QRIS Midtrans yang digambar langsung di aplikasi; tanpa isi permintaan. */
export const createQrisHandler: RequestHandler = async (req, res) => {
  res.json({ data: await buatQris(getUserId(req), String(req.params.code)) });
};

/**
 * `POST /payments/midtrans`: menerima webhook pembayaran dari Midtrans, yaitu pemberitahuan yang dikirim server
 * Midtrans ke server kita saat status pembayaran berubah. Tanpa token login; keasliannya diperiksa di service.
 * Bila diterima, dijawab `{ data: { ok: true } }`, karena Midtrans terus mengulang pemberitahuan sampai dijawab
 * sukses.
 */
export const midtransNotificationHandler: RequestHandler = async (req, res) => {
  await terimaNotifikasiMidtrans(bodyObject(req.body) as Record<string, unknown>);
  res.json({ data: { ok: true } });
};

/** `POST /orders/quote`: menghitung harga, potongan, dan peringatan stok tanpa menyimpan apa pun. */
export const quoteHandler: RequestHandler = async (req, res) => {
  res.json({ data: await quote(getUserId(req), req.body) });
};

/**
 * `POST /orders` (checkout): memeriksa isi permintaan dengan orderSchema dan header `Idempotency-Key` (UUID; galat
 * ditaruh di kolom `idempotency_key`), lalu membuat pesanan. Dijawab 201 berisi detail pesanan.
 * Idempotency-Key adalah kode unik per checkout, supaya kiriman ulang tidak membuat pesanan dobel.
 */
export const createOrderHandler: RequestHandler = async (req, res) => {
  const data = parse(orderSchema, req.body);
  const idempotencyKey = parse(idempotencyKeySchema, req.get("Idempotency-Key"), "idempotency_key");
  res.status(201).json({ data: await createOrder(getUserId(req), idempotencyKey, data) });
};

/** `GET /orders/:code`: detail satu pesanan milik pembeli yang login, termasuk info pembayarannya. */
export const getMyOrderHandler: RequestHandler = async (req, res) => {
  res.json({ data: await getMyOrder(getUserId(req), String(req.params.code)) });
};

/** `GET /orders/:code/whatsapp`: tautan wa.me berisi pesan dari pembeli ke toko untuk pesanan ini. */
export const getMyOrderWhatsappHandler: RequestHandler = async (req, res) => {
  res.json({ data: await getMyOrderWhatsapp(getUserId(req), String(req.params.code)) });
};

/** `GET /me/orders`: daftar pesanan pembeli per tab; jawabannya berisi `data` dan `meta` (info halaman). */
export const listMyOrdersHandler: RequestHandler = async (req, res) => {
  res.json(await listMyOrders(getUserId(req), parse(myOrdersQuerySchema, req.query)));
};

/** `POST /orders/:code/cancel`: pembeli membatalkan pesanan, alasan boleh kosong. */
export const cancelMyOrderHandler: RequestHandler = async (req, res) => {
  const { reason } = parse(reasonSchema, bodyObject(req.body));
  res.json({ data: await cancelMyOrder(getUserId(req), String(req.params.code), reason) });
};

/** `POST /orders/:code/complete`: pembeli menandai pesanan yang siap diambil sudah ia terima. */
export const completeMyOrderHandler: RequestHandler = async (req, res) => {
  res.json({ data: await completeMyOrder(getUserId(req), String(req.params.code)) });
};

/**
 * `POST /orders/:code/reviews`: ulasan untuk pesanan yang sudah selesai. Isi permintaan sudah diperiksa reviewSchema
 * di rute. Dijawab 201.
 */
export const createReviewHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await kirimUlasan(getUserId(req), String(req.params.code), req.body) });
};

/** `POST /orders/:code/reorder`: pesan lagi dari pesanan lama; dijawab keranjang siap kirim beserta rincian harganya. */
export const reorderHandler: RequestHandler = async (req, res) => {
  res.json({ data: await reorder(getUserId(req), String(req.params.code)) });
};
