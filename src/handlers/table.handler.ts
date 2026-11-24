// Isi file: handler HTTP fitur pesan dari meja, untuk kelola meja (penjual) dan pesanan tamu (publik). Lapisan kedua
// dari alur routes → handlers → services → database: ambil data permintaan, panggil table.service, kirim JSON.
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

// Isi permintaan sudah diperiksa skemanya di rute. getUserId = id penjual yang login (dipasang requireAuth).
const getUserId = (req: Request) => (req as AuthedRequest).auth.userId;
// Token tamu dikirim lewat header, bukan alamat URL, supaya tidak ikut tercatat di log server.
const getGuestToken = (req: Request) => req.get("x-guest-token") ?? "";

/** `GET /merchant/tables`: daftar meja milik toko penjual yang login. */
export const listTablesHandler: RequestHandler = async (req, res) => {
  res.json({ data: await listTables(getUserId(req)) });
};

/** `POST /merchant/tables`: membuat meja baru beserta token QR-nya, dijawab 201. */
export const createTableHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await createTable(getUserId(req), req.body.label) });
};

/** `PATCH /merchant/tables/:id`: mengubah nama/status meja atau mengganti token QR-nya. */
export const updateTableHandler: RequestHandler = async (req, res) => {
  res.json({ data: await updateTable(getUserId(req), req.params.id, req.body) });
};

/** `GET /tables/:token`: menu toko untuk tamu yang memindai QR meja. */
export const getTableMenuHandler: RequestHandler = async (req, res) => {
  res.json({ data: await getTableMenu(String(req.params.token)) });
};

/** `POST /tables/:token/orders`: membuat pesanan tamu, dijawab 201 berisi `guest_token` dan status pesanan. */
export const createTableOrderHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await createTableOrder(String(req.params.token), req.body) });
};

/** `GET /guest/orders/:code`: status pesanan tamu; token tamu dibaca dari header `X-Guest-Token`. */
export const getGuestOrderHandler: RequestHandler = async (req, res) => {
  res.json({ data: await getGuestOrder(String(req.params.code), getGuestToken(req)) });
};

/** `POST /guest/orders/:code/pay`: membuka halaman bayar Snap untuk pesanan tamu, dijawab `payment_url`. */
export const payGuestOrderHandler: RequestHandler = async (req, res) => {
  res.json({ data: await payGuestOrder(String(req.params.code), getGuestToken(req), req.body.kembali) });
};
