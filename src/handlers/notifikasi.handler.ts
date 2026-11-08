import { Request, RequestHandler } from "express";
import { daftarNotifSchema, tandaiSchema } from "../dto/notifikasi.dto";
import { bodyObjek } from "../dto/pesanan.dto";
import { AuthedRequest } from "../middleware/auth";
import { parse } from "../middleware/validate";
import { daftarNotifikasi, tandaiDibaca } from "../services/notifikasi.service";

const uid = (req: Request) => (req as AuthedRequest).auth.userId;

export const daftarNotifikasiHandler: RequestHandler = async (req, res) => {
  res.json(await daftarNotifikasi(uid(req), parse(daftarNotifSchema, req.query)));
};

export const tandaiDibacaHandler: RequestHandler = async (req, res) => {
  res.json({ data: await tandaiDibaca(uid(req), parse(tandaiSchema, bodyObjek(req.body))) });
};
