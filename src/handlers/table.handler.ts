// Handler HTTP fitur pesan dari meja (F21): kelola meja (penjual) dan pesanan tamu (publik).
// Lapisan kedua alur routes → handlers → services: ambil parameter request, panggil table.service, kirim JSON.
import { Request, RequestHandler } from "express";
import { AuthedRequest } from "../middleware/auth";
import {
  payGuestOrder,
  createTable,
  listTables,
  getTableMenu,
  createTableOrder,
  getGuestOrder,
  updateTable,
} from "../services/table.service";

// F21 pesan dari meja. Body sudah divalidasi skema di rute.
const uid = (req: Request) => (req as AuthedRequest).auth.userId;
// token tamu dikirim lewat header agar tidak tercatat di log URL
const getGuestToken = (req: Request) => req.get("x-guest-token") ?? "";

/** `GET /merchant/tables`: daftar meja milik toko penjual yang login. */
export const listTablesHandler: RequestHandler = async (req, res) => {
  res.json({ data: await listTables(uid(req)) });
};

/** `POST /merchant/tables`: buat meja baru beserta token QR-nya, dibalas 201. */
export const createTableHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await createTable(uid(req), req.body.label) });
};

/** `PATCH /merchant/tables/:id`: ubah nama/status meja atau ganti token QR. */
export const updateTableHandler: RequestHandler = async (req, res) => {
  res.json({ data: await updateTable(uid(req), req.params.id, req.body) });
};

/** `GET /tables/:token`: menu toko untuk tamu yang memindai QR meja. */
export const getTableMenuHandler: RequestHandler = async (req, res) => {
  res.json({ data: await getTableMenu(String(req.params.token)) });
};

/** `POST /tables/:token/orders`: buat pesanan tamu, dibalas 201 berisi `guest_token` dan status pesanan. */
export const createTableOrderHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await createTableOrder(String(req.params.token), req.body) });
};

/** `GET /guest/orders/:code`: status pesanan tamu; token tamu dibaca dari header `X-Guest-Token`. */
export const getGuestOrderHandler: RequestHandler = async (req, res) => {
  res.json({ data: await getGuestOrder(String(req.params.code), getGuestToken(req)) });
};

/** `POST /guest/orders/:code/pay`: buka halaman bayar Snap untuk pesanan tamu, dibalas `payment_url`. */
export const payGuestOrderHandler: RequestHandler = async (req, res) => {
  res.json({ data: await payGuestOrder(String(req.params.code), getGuestToken(req), req.body.kembali) });
};
