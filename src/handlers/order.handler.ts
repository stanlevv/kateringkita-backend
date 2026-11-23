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

const uid = (req: Request) => (req as AuthedRequest).auth.userId;

// F10: body sudah divalidasi vaSchema di rute
export const createVaHandler: RequestHandler = async (req, res) => {
  res.json({ data: await buatVa(uid(req), String(req.params.code), req.body.bank) });
};

// F26: body opsional (kosong = {})
export const payOnlineHandler: RequestHandler = async (req, res) => {
  const { kembali: returnUrl } = parse(payOnlineSchema, bodyObject(req.body));
  res.json({ data: await bayarOnline(uid(req), String(req.params.code), returnUrl) });
};

// QRIS di aplikasi: tanpa body
export const createQrisHandler: RequestHandler = async (req, res) => {
  res.json({ data: await buatQris(uid(req), String(req.params.code)) });
};

// F10: Midtrans mengulang notifikasi sampai dijawab 2xx
export const midtransNotificationHandler: RequestHandler = async (req, res) => {
  await terimaNotifikasiMidtrans(bodyObject(req.body) as Record<string, unknown>);
  res.json({ data: { ok: true } });
};

export const quoteHandler: RequestHandler = async (req, res) => {
  res.json({ data: await quote(uid(req), req.body) });
};

export const createOrderHandler: RequestHandler = async (req, res) => {
  const data = parse(orderSchema, req.body);
  const idempotencyKey = parse(idempotencyKeySchema, req.get("Idempotency-Key"), "idempotency_key");
  res.status(201).json({ data: await createOrder(uid(req), idempotencyKey, data) });
};

export const getMyOrderHandler: RequestHandler = async (req, res) => {
  res.json({ data: await getMyOrder(uid(req), String(req.params.code)) });
};

export const getMyOrderWhatsappHandler: RequestHandler = async (req, res) => {
  res.json({ data: await getMyOrderWhatsapp(uid(req), String(req.params.code)) });
};

export const listMyOrdersHandler: RequestHandler = async (req, res) => {
  res.json(await listMyOrders(uid(req), parse(myOrdersQuerySchema, req.query)));
};

export const cancelMyOrderHandler: RequestHandler = async (req, res) => {
  const { reason } = parse(reasonSchema, bodyObject(req.body));
  res.json({ data: await cancelMyOrder(uid(req), String(req.params.code), reason) });
};

export const completeMyOrderHandler: RequestHandler = async (req, res) => {
  res.json({ data: await completeMyOrder(uid(req), String(req.params.code)) });
};

// F13: ulasan pesanan selesai (body sudah divalidasi reviewSchema di rute)
export const createReviewHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await kirimUlasan(uid(req), String(req.params.code), req.body) });
};

// F14: pesan lagi dari pesanan lama
export const reorderHandler: RequestHandler = async (req, res) => {
  res.json({ data: await reorder(uid(req), String(req.params.code)) });
};
