import { Request, RequestHandler } from "express";
import { AuthedRequest } from "../middleware/auth";
import { parse } from "../middleware/validate";
import { halamanSchema } from "../dto/pencairan.dto";
import { catatPencairan, daftarRefund, daftarSaldo, pencairanSaya, riwayatPencairan, tandaiRefund, ubahRekening } from "../services/pencairan.service";

// F26 pencairan dana; body sudah divalidasi di rute
const uid = (req: Request) => (req as AuthedRequest).auth.userId;

export const pencairanSayaHandler: RequestHandler = async (req, res) => {
  res.json({ data: await pencairanSaya(uid(req)) });
};
export const ubahRekeningHandler: RequestHandler = async (req, res) => {
  res.json({ data: await ubahRekening(uid(req), req.body) });
};

export const daftarSaldoHandler: RequestHandler = async (_req, res) => {
  res.json({ data: await daftarSaldo() });
};
export const catatPencairanHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await catatPencairan(uid(req), req.body) });
};
export const riwayatPencairanHandler: RequestHandler = async (req, res) => {
  res.json(await riwayatPencairan(parse(halamanSchema, req.query).page));
};
export const daftarRefundHandler: RequestHandler = async (_req, res) => {
  res.json({ data: await daftarRefund() });
};
export const tandaiRefundHandler: RequestHandler = async (req, res) => {
  res.json({ data: await tandaiRefund(uid(req), String(req.params.code), req.body) });
};
