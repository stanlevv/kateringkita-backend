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

export const listTablesHandler: RequestHandler = async (req, res) => {
  res.json({ data: await listTables(uid(req)) });
};

export const createTableHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await createTable(uid(req), req.body.label) });
};

export const updateTableHandler: RequestHandler = async (req, res) => {
  res.json({ data: await updateTable(uid(req), req.params.id, req.body) });
};

export const getTableMenuHandler: RequestHandler = async (req, res) => {
  res.json({ data: await getTableMenu(String(req.params.token)) });
};

export const createTableOrderHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await createTableOrder(String(req.params.token), req.body) });
};

export const getGuestOrderHandler: RequestHandler = async (req, res) => {
  res.json({ data: await getGuestOrder(String(req.params.code), getGuestToken(req)) });
};

export const payGuestOrderHandler: RequestHandler = async (req, res) => {
  res.json({ data: await payGuestOrder(String(req.params.code), getGuestToken(req), req.body.kembali) });
};
