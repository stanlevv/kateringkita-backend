import { Request, RequestHandler } from "express";
import { bodyObjek } from "../dto/pesanan.dto";
import { balasTiketSchema, buatTiketSchema, daftarTiketSchema } from "../dto/tiket.dto";
import { AuthedRequest } from "../middleware/auth";
import { parse } from "../middleware/validate";
import { bacaTiketSaya, balasTiketSaya, buatTiket, daftarTiketSaya, tutupTiketSaya } from "../services/tiket.service";

// Tiket bantuan (CS). Body bukan objek (kosong, teks) dianggap {} agar galat tetap per field.
const uid = (req: Request) => (req as AuthedRequest).auth.userId;
const kode = (req: Request) => String(req.params.code);
const isiBalasan = (req: Request) => parse(balasTiketSchema, bodyObjek(req.body)).body;

export const buatTiketHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await buatTiket(uid(req), parse(buatTiketSchema, bodyObjek(req.body))) });
};

export const daftarTiketSayaHandler: RequestHandler = async (req, res) => {
  res.json(await daftarTiketSaya(uid(req), parse(daftarTiketSchema, req.query)));
};

export const bacaTiketSayaHandler: RequestHandler = async (req, res) => {
  res.json({ data: await bacaTiketSaya(uid(req), kode(req)) });
};

export const balasTiketSayaHandler: RequestHandler = async (req, res) => {
  const body = isiBalasan(req);
  res.status(201).json({ data: await balasTiketSaya(uid(req), kode(req), body) });
};

export const tutupTiketSayaHandler: RequestHandler = async (req, res) => {
  res.json({ data: await tutupTiketSaya(uid(req), kode(req)) });
};
