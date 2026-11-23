import { Request, RequestHandler } from "express";
import { myVouchersSchema } from "../dto/voucher.dto";
import { AuthedRequest } from "../middleware/auth";
import { parse } from "../middleware/validate";
import { clock } from "../services/catalog.service";
import { claimVoucher, listPlatformVouchers, listMyVouchers } from "../services/voucher.service";

const getUserId = (req: Request) => (req as AuthedRequest).auth.userId;
// claimed hanya untuk sesi pembeli; tamu / peran lain → null
const getCustomerId = (req: Request) => {
  const auth = (req as Partial<AuthedRequest>).auth;
  return auth?.role === "customer" ? auth.userId : null;
};

export const listPlatformVouchersHandler: RequestHandler = async (req, res) => {
  res.json({ data: await listPlatformVouchers(getCustomerId(req), clock.now()) });
};

export const claimVoucherHandler: RequestHandler = async (req, res) => {
  res.json({ data: await claimVoucher(getUserId(req), req.params.id) });
};

export const listMyVouchersHandler: RequestHandler = async (req, res) => {
  res.json({ data: await listMyVouchers(getUserId(req), parse(myVouchersSchema, req.query)) });
};
