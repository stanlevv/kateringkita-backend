import { Request, RequestHandler } from "express";
import { AuthedRequest } from "../middleware/auth";
import { createPopup, listPopups, getPublicPopup, updatePopup } from "../services/popup.service";

// Pop-up promo mobile (rancangan voucher 2026-11-16 §5.5). Body divalidasi di service (zod + cek gambar sekaligus).
const getUserId = (req: Request) => (req as AuthedRequest).auth.userId;
const getCustomerId = (req: Request) => {
  const auth = (req as Partial<AuthedRequest>).auth;
  return auth?.role === "customer" ? auth.userId : null;
};

export const getPublicPopupHandler: RequestHandler = async (req, res) => {
  res.json({ data: await getPublicPopup(getCustomerId(req)) });
};
export const listPopupsHandler: RequestHandler = async (_req, res) => {
  res.json({ data: await listPopups() });
};
export const createPopupHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await createPopup(getUserId(req), req.body) });
};
export const updatePopupHandler: RequestHandler = async (req, res) => {
  res.json({ data: await updatePopup(getUserId(req), req.params.id, req.body) });
};
