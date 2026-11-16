import { Request, RequestHandler } from "express";
import { voucherSayaSchema } from "../dto/voucher.dto";
import { AuthedRequest } from "../middleware/auth";
import { parse } from "../middleware/validate";
import { jam } from "../services/katalog.service";
import { klaimVoucher, voucherPlatform, voucherSaya } from "../services/voucher.service";

const uid = (req: Request) => (req as AuthedRequest).auth.userId;
// claimed hanya untuk sesi pembeli; tamu / peran lain → null
const pembeli = (req: Request) => {
  const auth = (req as Partial<AuthedRequest>).auth;
  return auth?.role === "customer" ? auth.userId : null;
};

export const voucherPlatformHandler: RequestHandler = async (req, res) => {
  res.json({ data: await voucherPlatform(pembeli(req), jam.sekarang()) });
};

export const klaimVoucherHandler: RequestHandler = async (req, res) => {
  res.json({ data: await klaimVoucher(uid(req), req.params.id) });
};

export const voucherSayaHandler: RequestHandler = async (req, res) => {
  res.json({ data: await voucherSaya(uid(req), parse(voucherSayaSchema, req.query)) });
};
