import { Request, RequestHandler } from "express";
import { daftarBannerSchema } from "../dto/banner.dto";
import { AuthedRequest } from "../middleware/auth";
import { parse } from "../middleware/validate";
import {
  bannerPublik,
  buatBannerAdmin,
  buatBannerToko,
  daftarBannerAdmin,
  daftarBannerToko,
  hapusBannerToko,
  tinjauBanner,
  ubahBannerToko,
} from "../services/banner.service";
import { buatUnggahan } from "../services/upload.service";

// Banner beranda (rancangan voucher 2026-11-16 §5.4). Body divalidasi di service (zod + cek gambar sekaligus).
const uid = (req: Request) => (req as AuthedRequest).auth.userId;
const pembeli = (req: Request) => {
  const auth = (req as Partial<AuthedRequest>).auth;
  return auth?.role === "customer" ? auth.userId : null;
};

export const bannerPublikHandler: RequestHandler = async (req, res) => {
  res.json({ data: await bannerPublik(pembeli(req)) });
};

export const daftarBannerTokoHandler: RequestHandler = async (req, res) => {
  res.json({ data: await daftarBannerToko(uid(req)) });
};
export const buatBannerTokoHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await buatBannerToko(uid(req), req.body) });
};
export const ubahBannerTokoHandler: RequestHandler = async (req, res) => {
  res.json({ data: await ubahBannerToko(uid(req), req.params.id, req.body) });
};
export const hapusBannerTokoHandler: RequestHandler = async (req, res) => {
  res.json({ data: await hapusBannerToko(uid(req), req.params.id) });
};

export const daftarBannerAdminHandler: RequestHandler = async (req, res) => {
  res.json({ data: await daftarBannerAdmin(parse(daftarBannerSchema, req.query).status) });
};
export const buatBannerAdminHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await buatBannerAdmin(uid(req), req.body) });
};
export const tinjauBannerHandler: RequestHandler = async (req, res) => {
  res.json({ data: await tinjauBanner(uid(req), req.params.id, req.body) });
};

// Gambar banner / pop-up platform; body sudah divalidasi adminUploadSchema di rute
export const uploadAdminHandler: RequestHandler = async (req, res) => {
  const { purpose, ...file } = req.body;
  res.json({ data: buatUnggahan(`platform/${purpose}/`, file) });
};
