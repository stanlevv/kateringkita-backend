// Isi file: handler HTTP semua fitur penjual: profil toko, menu dan kuota, unggah foto, pesanan toko, laporan, promo,
// ulasan, dan asisten AI. Handler membaca request (path, query, body, data login), memanggil service, lalu mengirim
// JSON. Alurnya routes/merchant.ts → file ini → service fitur masing-masing → database.
import { RequestHandler } from "express";
import { quotaSchema, menuQuerySchema } from "../dto/merchant-menu.dto";
import { merchantOrdersQuerySchema } from "../dto/merchant-order.dto";
import { reportRangeSchema, reportDateSchema } from "../dto/merchant-report.dto";
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
import { getHourlyReport, getTransactionReport, getReportSummary } from "../services/merchant-report.service";
import {
  createMerchantPromo,
  listMerchantPromos,
  deleteMerchantPromo,
  updateMerchantPromo,
} from "../services/merchant-promo.service";
import { listMerchantReviews } from "../services/review.service";
import { askAssistant } from "../services/assistant.service";
import { createUpload } from "../services/upload.service";
import { AppError } from "../utils/errors";

// Id penjual yang login, dari token (dipasang requireAuth). Toko selalu dicari dari id ini, tidak pernah dari isi
// request, jadi penjual hanya bisa menyentuh tokonya sendiri.
const getUserId = (req: unknown) => (req as AuthedRequest).auth.userId;

/**
 * GET /merchant/profile: profil toko penjual yang login.
 * @param req request dari penjual yang login
 * @param res respons `{ data }` berisi profil toko, atau 404 bila pengguna tidak punya toko
 * @returns tidak ada; hasil dikirim lewat `res`
 */
export const getProfileHandler: RequestHandler = async (req, res) => {
  res.json({ data: await getProfile(getUserId(req)) });
};

/**
 * PATCH /merchant/status: membuka atau menutup dapur toko.
 * @param req request dengan body `{ is_open }` yang sudah lolos openStatusSchema
 * @param res respons `{ data: { is_open } }`
 * @returns tidak ada; hasil dikirim lewat `res`
 */
export const setOpenHandler: RequestHandler = async (req, res) => {
  res.json({ data: await setOpen(getUserId(req), req.body.is_open) });
};

/**
 * PATCH /merchant/profile: mengubah sebagian profil toko.
 * @param req request dengan body yang sudah lolos updateProfileSchema
 * @param res respons `{ data }` berisi profil terbaru, atau 400/404 (lihat updateProfile)
 * @returns tidak ada; hasil dikirim lewat `res`
 */
export const updateProfileHandler: RequestHandler = async (req, res) => {
  res.json({ data: await updateProfile(getUserId(req), req.body) });
};

/**
 * GET /merchant/menus: daftar menu toko dengan pencarian dan filter.
 * @param req request dengan query `q`, `category`, `status` (diperiksa menuQuerySchema di sini)
 * @param res respons `{ data }` berisi daftar menu
 * @returns tidak ada; hasil dikirim lewat `res`
 */
export const listMenusHandler: RequestHandler = async (req, res) => {
  res.json({ data: await listMenus(getUserId(req), parse(menuQuerySchema, req.query)) });
};

/**
 * GET /merchant/menus/:id: detail satu menu toko.
 * @param req request dengan `id` menu di path
 * @param res respons `{ data }` berisi menu, atau 404 bila menu tidak ditemukan
 * @returns tidak ada; hasil dikirim lewat `res`
 */
export const getMenuHandler: RequestHandler = async (req, res) => {
  res.json({ data: await getMenu(getUserId(req), req.params.id) });
};

/**
 * POST /merchant/menus: menambah menu baru, dijawab 201.
 * @param req request dengan body yang sudah lolos menuSchema
 * @param res respons 201 `{ data }` berisi menu baru
 * @returns tidak ada; hasil dikirim lewat `res`
 */
export const createMenuHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await createMenu(getUserId(req), req.body) });
};

/**
 * PATCH /merchant/menus/:id: mengubah sebagian data menu.
 * @param req request dengan `id` menu di path dan body yang sudah lolos menuPatchSchema
 * @param res respons `{ data }` berisi menu terbaru, atau 400/404/409 (lihat updateMenu)
 * @returns tidak ada; hasil dikirim lewat `res`
 */
export const updateMenuHandler: RequestHandler = async (req, res) => {
  res.json({ data: await updateMenu(getUserId(req), req.params.id, req.body) });
};

/**
 * DELETE /merchant/menus/:id: menghapus menu (soft delete), dijawab 204 tanpa isi.
 * @param req request dengan `id` menu di path
 * @param res respons 204, atau 404 bila menu tidak ditemukan
 * @returns tidak ada; hasil dikirim lewat `res`
 */
export const deleteMenuHandler: RequestHandler = async (req, res) => {
  await deleteMenu(getUserId(req), req.params.id);
  res.status(204).end();
};

/**
 * PATCH /merchant/menus/:id/quota: mengubah kuota hari ini satu menu. Body diperiksa di sini, bukan lewat `validate`
 * di route, supaya galat "tepat salah satu dari delta atau quota_today" bisa dikirim tanpa `fields`.
 * @param req request dengan `id` menu di path dan body `{ delta }` atau `{ quota_today }`
 * @param res respons `{ data }` berisi menu dengan kuota terbaru
 * @returns tidak ada; hasil dikirim lewat `res`
 * @throws 400 "Data kuota tidak valid." bila body tidak lolos quotaSchema; galat lain dari updateQuota
 */
export const updateQuotaHandler: RequestHandler = async (req, res) => {
  // 1. Periksa body dengan quotaSchema.
  const parsed = quotaSchema.safeParse(req.body);
  if (!parsed.success) {
    // 2. Bila gagal: galat lintas kolom (path kosong) tidak punya nama kolom, jadi dibuang dari `fields`; galat per
    //    kolom tetap dikirim. Bila tidak ada galat per kolom, `fields` tidak dikirim sama sekali.
    const fields = fieldsFromIssues(parsed.error.issues.filter((issue) => issue.path.length > 0));
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "Data kuota tidak valid.",
      Object.keys(fields).length ? fields : undefined,
    );
  }
  // 3. Ubah kuota dan kirim menu terbaru.
  res.json({ data: await updateQuota(getUserId(req), req.params.id, parsed.data) });
};

/**
 * POST /merchant/uploads: meminta alamat unggah foto. Foto disimpan di folder `merchants/<id toko>/<purpose>/`;
 * `purpose` dibatasi skema (menu, logo, banner, cover), jadi penjual hanya bisa mengunggah ke folder tokonya sendiri.
 * @param req request dengan body yang sudah lolos merchantUploadSchema: `purpose`, `content_type`, dan `size`
 * @param res respons `{ data }` berisi alamat unggah sementara, alamat publik foto, dan batas waktunya
 * @returns tidak ada; hasil dikirim lewat `res`
 */
export const uploadPhotoHandler: RequestHandler = async (req, res) => {
  const { purpose, ...file } = req.body;
  res.json({ data: createUpload(`merchants/${await getMerchantId(getUserId(req))}/${purpose}/`, file) });
};

/**
 * GET /merchant/orders: daftar pesanan toko per halaman, dengan filter.
 * @param req request dengan query filter (diperiksa merchantOrdersQuerySchema di sini)
 * @param res respons `{ data, meta }`
 * @returns tidak ada; hasil dikirim lewat `res`
 */
export const listMerchantOrdersHandler: RequestHandler = async (req, res) => {
  res.json(await listMerchantOrders(getUserId(req), parse(merchantOrdersQuerySchema, req.query)));
};

/**
 * GET /merchant/orders/:code: detail satu pesanan toko.
 * @param req request dengan kode pesanan di path
 * @param res respons `{ data }` berisi detail pesanan, atau 404 bila bukan pesanan toko ini
 * @returns tidak ada; hasil dikirim lewat `res`
 */
export const getMerchantOrderHandler: RequestHandler = async (req, res) => {
  res.json({ data: await getMerchantOrder(getUserId(req), String(req.params.code)) });
};

/**
 * GET /merchant/orders/:code/whatsapp: tautan chat WhatsApp ke pembeli untuk satu pesanan toko.
 * @param req request dengan kode pesanan di path
 * @param res respons `{ data }` berisi nomor WA pembeli, isi pesan dari templat toko, dan tautan wa.me
 * @returns tidak ada; hasil dikirim lewat `res`
 */
export const getMerchantOrderWhatsappHandler: RequestHandler = async (req, res) => {
  res.json({ data: await getMerchantOrderWhatsapp(getUserId(req), String(req.params.code)) });
};

/**
 * POST /merchant/orders/:code/:aksi: aksi penjual pada pesanan (confirm, cook, ready, complete, reject). Aksi di luar
 * MERCHANT_ACTIONS tidak diproses di sini, tetapi diteruskan ke handler berikutnya sehingga dijawab 404.
 * @param req  request dengan kode pesanan dan nama aksi di path; body berisi alasan untuk aksi reject
 * @param res  respons `{ data }` berisi pesanan setelah aksi
 * @param next fungsi Express untuk meneruskan ke handler berikutnya
 * @returns tidak ada; hasil dikirim lewat `res`
 */
export const transitionMerchantOrderHandler: RequestHandler = async (req, res, next) => {
  const action = String(req.params.aksi) as MerchantAction;
  if (!MERCHANT_ACTIONS.includes(action)) return next();
  res.json({ data: await transitionMerchantOrder(getUserId(req), String(req.params.code), action, req.body) });
};

/**
 * GET /merchant/reports/summary: ringkasan laporan penjualan toko untuk rentang tanggal.
 * @param req request dengan query `from` dan `to` (diperiksa reportRangeSchema di sini)
 * @param res respons `{ data }` berisi ringkasan laporan
 * @returns tidak ada; hasil dikirim lewat `res`
 */
export const getReportSummaryHandler: RequestHandler = async (req, res) => {
  res.json({ data: await getReportSummary(getUserId(req), parse(reportRangeSchema, req.query)) });
};

/**
 * GET /merchant/reports/hourly: penjualan toko per jam untuk satu tanggal.
 * @param req request dengan query `date` (diperiksa reportDateSchema di sini)
 * @param res respons `{ data }` berisi penjualan per jam
 * @returns tidak ada; hasil dikirim lewat `res`
 */
export const getHourlyReportHandler: RequestHandler = async (req, res) => {
  res.json({ data: await getHourlyReport(getUserId(req), parse(reportDateSchema, req.query).date) });
};

/**
 * GET /merchant/reports/transactions: daftar transaksi toko untuk rentang tanggal.
 * @param req request dengan query `from` dan `to` (diperiksa reportRangeSchema di sini)
 * @param res respons `{ data }` berisi daftar transaksi
 * @returns tidak ada; hasil dikirim lewat `res`
 */
export const listReportTransactionsHandler: RequestHandler = async (req, res) => {
  res.json({ data: await getTransactionReport(getUserId(req), parse(reportRangeSchema, req.query)) });
};

/**
 * GET /merchant/promos: daftar promo milik toko.
 * @param req request dari penjual yang login
 * @param res respons `{ data }` berisi daftar promo
 * @returns tidak ada; hasil dikirim lewat `res`
 */
export const listMerchantPromosHandler: RequestHandler = async (req, res) => {
  res.json({ data: await listMerchantPromos(getUserId(req)) });
};

/**
 * POST /merchant/promos: membuat promo toko, dijawab 201. Body diperiksa di service.
 * @param req request dengan body data promo
 * @param res respons 201 `{ data }` berisi promo baru
 * @returns tidak ada; hasil dikirim lewat `res`
 */
export const createMerchantPromoHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await createMerchantPromo(getUserId(req), req.body) });
};

/**
 * PATCH /merchant/promos/:id: mengubah promo toko. Body diperiksa di service.
 * @param req request dengan `id` promo di path dan body perubahan
 * @param res respons `{ data }` berisi promo terbaru
 * @returns tidak ada; hasil dikirim lewat `res`
 */
export const updateMerchantPromoHandler: RequestHandler = async (req, res) => {
  res.json({ data: await updateMerchantPromo(getUserId(req), req.params.id, req.body) });
};

/**
 * DELETE /merchant/promos/:id: menghapus promo toko yang belum pernah dipakai. Dijawab `{ data: { id } }`, bukan 204
 * tanpa isi, supaya fungsi `hasil()` di web menerimanya sebagai sukses. Promo yang sudah dipakai ditolak 409.
 * @param req request dengan `id` promo di path
 * @param res respons `{ data: { id } }`
 * @returns tidak ada; hasil dikirim lewat `res`
 */
export const deleteMerchantPromoHandler: RequestHandler = async (req, res) => {
  res.json({ data: await deleteMerchantPromo(getUserId(req), req.params.id) });
};

/**
 * GET /merchant/reviews: ulasan pembeli untuk menu-menu toko (yang tidak disembunyikan admin).
 * @param req request dari penjual yang login
 * @param res respons `{ data }` berisi daftar ulasan, terbaru di atas
 * @returns tidak ada; hasil dikirim lewat `res`
 */
export const listMerchantReviewsHandler: RequestHandler = async (req, res) => {
  res.json({ data: await listMerchantReviews(getUserId(req)) });
};

/**
 * POST /merchant/assistant: pertanyaan penjual ke asisten AI toko. Body sudah diperiksa askAssistantSchema di route.
 * @param req request dengan body `{ question }`
 * @param res respons `{ data }` berisi jawaban asisten
 * @returns tidak ada; hasil dikirim lewat `res`
 */
export const askAssistantHandler: RequestHandler = async (req, res) => {
  res.json({ data: await askAssistant(getUserId(req), req.body.question) });
};
