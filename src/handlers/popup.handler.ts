import { Request, RequestHandler } from "express";
import { AuthedRequest } from "../middleware/auth";
import { buatPopup, daftarPopup, popupPublik, ubahPopup } from "../services/popup.service";

// Pop-up promo mobile (rancangan voucher 2026-11-16 §5.5). Body divalidasi di service (zod + cek gambar sekaligus).
const uid = (req: Request) => (req as AuthedRequest).auth.userId;
const pembeli = (req: Request) => {
  const auth = (req as Partial<AuthedRequest>).auth;
  return auth?.role === "customer" ? auth.userId : null;
};

export const popupPublikHandler: RequestHandler = async (req, res) => {
  res.json({ data: await popupPublik(pembeli(req)) });
};
export const daftarPopupHandler: RequestHandler = async (_req, res) => {
  res.json({ data: await daftarPopup() });
};
export const buatPopupHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await buatPopup(uid(req), req.body) });
};
export const ubahPopupHandler: RequestHandler = async (req, res) => {
  res.json({ data: await ubahPopup(uid(req), req.params.id, req.body) });
};
