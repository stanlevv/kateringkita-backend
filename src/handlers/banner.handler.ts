import { Request, RequestHandler } from "express";
import { listBannersSchema } from "../dto/banner.dto";
import { AuthedRequest } from "../middleware/auth";
import { parse } from "../middleware/validate";
import {
  listPublicBanners,
  createAdminBanner,
  createMerchantBanner,
  listAdminBanners,
  listMerchantBanners,
  deleteMerchantBanner,
  reviewBanner,
  updateMerchantBanner,
} from "../services/banner.service";
import { createUpload } from "../services/upload.service";

// Banner beranda (rancangan voucher 2026-11-16 §5.4). Body divalidasi di service (zod + cek gambar sekaligus).
const getUserId = (req: Request) => (req as AuthedRequest).auth.userId;
const getCustomerId = (req: Request) => {
  const auth = (req as Partial<AuthedRequest>).auth;
  return auth?.role === "customer" ? auth.userId : null;
};

export const listPublicBannersHandler: RequestHandler = async (req, res) => {
  res.json({ data: await listPublicBanners(getCustomerId(req)) });
};

export const listMerchantBannersHandler: RequestHandler = async (req, res) => {
  res.json({ data: await listMerchantBanners(getUserId(req)) });
};
export const createMerchantBannerHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await createMerchantBanner(getUserId(req), req.body) });
};
export const updateMerchantBannerHandler: RequestHandler = async (req, res) => {
  res.json({ data: await updateMerchantBanner(getUserId(req), req.params.id, req.body) });
};
export const deleteMerchantBannerHandler: RequestHandler = async (req, res) => {
  res.json({ data: await deleteMerchantBanner(getUserId(req), req.params.id) });
};

export const listAdminBannersHandler: RequestHandler = async (req, res) => {
  res.json({ data: await listAdminBanners(parse(listBannersSchema, req.query).status) });
};
export const createAdminBannerHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await createAdminBanner(getUserId(req), req.body) });
};
export const reviewBannerHandler: RequestHandler = async (req, res) => {
  res.json({ data: await reviewBanner(getUserId(req), req.params.id, req.body) });
};

// Gambar banner / pop-up platform; body sudah divalidasi adminUploadSchema di rute
export const uploadAdminHandler: RequestHandler = async (req, res) => {
  const { purpose, ...file } = req.body;
  res.json({ data: createUpload(`platform/${purpose}/`, file) });
};
