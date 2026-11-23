import { RequestHandler } from "express";
import { quotaSchema, menuQuerySchema } from "../dto/merchant-menu.dto";
import { merchantOrdersQuerySchema } from "../dto/merchant-order.dto";
import { rentangSchema, tanggalSchema } from "../dto/merchant-laporan.dto";
import { AuthedRequest } from "../middleware/auth";
import { fieldsFromIssues, parse } from "../middleware/validate";
import {
  getMenu,
  createMenu,
  listMenus,
  deleteMenu,
  getMerchantId,
  updateQuota,
  updateMenu,
} from "../services/merchant-menu.service";
import {
  MERCHANT_ACTIONS,
  MerchantAction,
  transitionMerchantOrder,
  getMerchantOrder,
  listMerchantOrders,
  getMerchantOrderWhatsapp,
} from "../services/merchant-order.service";
import { getProfile, setOpen, updateProfile } from "../services/merchant.service";
import { laporanPerJam, laporanTransaksi, ringkasanLaporan } from "../services/merchant-laporan.service";
import { buatPromoToko, daftarPromoToko, hapusPromoToko, ubahPromoToko } from "../services/merchant-promo.service";
import { daftarUlasanToko } from "../services/ulasan.service";
import { tanyaAsisten } from "../services/asisten.service";
import { createUpload } from "../services/upload.service";
import { AppError } from "../utils/errors";

// Toko selalu dari token (R-10).
const getUserId = (req: unknown) => (req as AuthedRequest).auth.userId;

export const getProfileHandler: RequestHandler = async (req, res) => {
  res.json({ data: await getProfile(getUserId(req)) });
};

export const setOpenHandler: RequestHandler = async (req, res) => {
  res.json({ data: await setOpen(getUserId(req), req.body.is_open) });
};

export const updateProfileHandler: RequestHandler = async (req, res) => {
  res.json({ data: await updateProfile(getUserId(req), req.body) });
};

export const listMenusHandler: RequestHandler = async (req, res) => {
  res.json({ data: await listMenus(getUserId(req), parse(menuQuerySchema, req.query)) });
};

export const getMenuHandler: RequestHandler = async (req, res) => {
  res.json({ data: await getMenu(getUserId(req), req.params.id) });
};

export const createMenuHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await createMenu(getUserId(req), req.body) });
};

export const updateMenuHandler: RequestHandler = async (req, res) => {
  res.json({ data: await updateMenu(getUserId(req), req.params.id, req.body) });
};

export const deleteMenuHandler: RequestHandler = async (req, res) => {
  await deleteMenu(getUserId(req), req.params.id);
  res.status(204).end();
};

export const updateQuotaHandler: RequestHandler = async (req, res) => {
  const parsed = quotaSchema.safeParse(req.body);
  if (!parsed.success) {
    // galat lintas-field (path kosong) tidak punya field; galat per field tetap di fields
    const fields = fieldsFromIssues(parsed.error.issues.filter((issue) => issue.path.length > 0));
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "Data kuota tidak valid.",
      Object.keys(fields).length ? fields : undefined,
    );
  }
  res.json({ data: await updateQuota(getUserId(req), req.params.id, parsed.data) });
};

export const uploadPhotoHandler: RequestHandler = async (req, res) => {
  const { purpose, ...file } = req.body;
  res.json({ data: createUpload(`merchants/${await getMerchantId(getUserId(req))}/${purpose}/`, file) });
};

export const listMerchantOrdersHandler: RequestHandler = async (req, res) => {
  res.json(await listMerchantOrders(getUserId(req), parse(merchantOrdersQuerySchema, req.query)));
};

export const getMerchantOrderHandler: RequestHandler = async (req, res) => {
  res.json({ data: await getMerchantOrder(getUserId(req), String(req.params.code)) });
};

export const getMerchantOrderWhatsappHandler: RequestHandler = async (req, res) => {
  res.json({ data: await getMerchantOrderWhatsapp(getUserId(req), String(req.params.code)) });
};

// aksi di luar MERCHANT_ACTIONS → lanjut ke notFoundHandler (404)
export const transitionMerchantOrderHandler: RequestHandler = async (req, res, next) => {
  const action = String(req.params.aksi) as MerchantAction;
  if (!MERCHANT_ACTIONS.includes(action)) return next();
  res.json({ data: await transitionMerchantOrder(getUserId(req), String(req.params.code), action, req.body) });
};

// F09 laporan (LP-N1..N4)
export const getReportSummaryHandler: RequestHandler = async (req, res) => {
  res.json({ data: await ringkasanLaporan(getUserId(req), parse(rentangSchema, req.query)) });
};

export const getHourlyReportHandler: RequestHandler = async (req, res) => {
  res.json({ data: await laporanPerJam(getUserId(req), parse(tanggalSchema, req.query).date) });
};

export const listReportTransactionsHandler: RequestHandler = async (req, res) => {
  res.json({ data: await laporanTransaksi(getUserId(req), parse(rentangSchema, req.query)) });
};

// F12 promo toko
export const listMerchantPromosHandler: RequestHandler = async (req, res) => {
  res.json({ data: await daftarPromoToko(getUserId(req)) });
};

export const createMerchantPromoHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await buatPromoToko(getUserId(req), req.body) });
};

export const updateMerchantPromoHandler: RequestHandler = async (req, res) => {
  res.json({ data: await ubahPromoToko(getUserId(req), req.params.id, req.body) });
};

// {data:{id}} (bukan 204) agar fe hasil() menerima sukses
export const deleteMerchantPromoHandler: RequestHandler = async (req, res) => {
  res.json({ data: await hapusPromoToko(getUserId(req), req.params.id) });
};

// F13 ulasan toko
export const listMerchantReviewsHandler: RequestHandler = async (req, res) => {
  res.json({ data: await daftarUlasanToko(getUserId(req)) });
};

// F17 asisten AI toko (body divalidasi tanyaSchema di rute)
export const askAssistantHandler: RequestHandler = async (req, res) => {
  res.json({ data: await tanyaAsisten(getUserId(req), req.body.question) });
};
