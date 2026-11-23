// Isi file: handler HTTP banner beranda dan unggah gambar platform (banner dan pop-up). Rute publik ada di
// routes/catalog.ts, rute penjual di routes/merchant.ts, rute admin di routes/admin.ts. Isi permintaan banner diperiksa
// di banner.service (zod dan cek gambar sekaligus). Alurnya routes → file ini → services/banner.service.ts → database.
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

// id pengguna yang login (penjual atau admin), sudah dipasang middleware requireAuth di rute.
const getUserId = (req: Request) => (req as AuthedRequest).auth.userId;
// Tanda `claimed` voucher hanya dihitung untuk sesi pembeli; tamu dan peran lain dianggap null.
const getCustomerId = (req: Request) => {
  const auth = (req as Partial<AuthedRequest>).auth;
  return auth?.role === "customer" ? auth.userId : null;
};

/**
 * `GET /banners`: banner yang sedang tayang di beranda. Boleh tanpa login.
 * @param req permintaan; token login opsional
 * @param res jawaban `{ data: [banner] }`
 * @returns selesai setelah jawaban dikirim
 */
export const listPublicBannersHandler: RequestHandler = async (req, res) => {
  res.json({ data: await listPublicBanners(getCustomerId(req)) });
};

/**
 * `GET /merchant/banners`: semua banner milik toko penjual.
 * @param req permintaan dari penjual yang login
 * @param res jawaban `{ data: [banner] }`
 * @returns selesai setelah jawaban dikirim
 * @throws 404 pengguna tidak punya toko
 */
export const listMerchantBannersHandler: RequestHandler = async (req, res) => {
  res.json({ data: await listMerchantBanners(getUserId(req)) });
};
/**
 * `POST /merchant/banners`: penjual mengajukan banner baru.
 * @param req permintaan berisi isi banner
 * @param res jawaban 201 `{ data: banner }` berstatus menunggu
 * @returns selesai setelah jawaban dikirim
 * @throws 400 isian tidak valid, 409 toko sudah punya banner aktif
 */
export const createMerchantBannerHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await createMerchantBanner(getUserId(req), req.body) });
};
/**
 * `PATCH /merchant/banners/:id`: penjual mengubah banner; banner kembali menunggu persetujuan.
 * @param req permintaan dengan `:id` banner dan kolom yang diubah
 * @param res jawaban `{ data: banner }`
 * @returns selesai setelah jawaban dikirim
 * @throws 400 isian tidak valid, 404 banner tidak ada, 409 toko sudah punya banner aktif lain
 */
export const updateMerchantBannerHandler: RequestHandler = async (req, res) => {
  res.json({ data: await updateMerchantBanner(getUserId(req), req.params.id, req.body) });
};
/**
 * `DELETE /merchant/banners/:id`: penjual menghapus banner tokonya.
 * @param req permintaan dengan `:id` banner
 * @param res jawaban `{ data: { id } }`
 * @returns selesai setelah jawaban dikirim
 * @throws 404 banner tidak ada atau milik toko lain
 */
export const deleteMerchantBannerHandler: RequestHandler = async (req, res) => {
  res.json({ data: await deleteMerchantBanner(getUserId(req), req.params.id) });
};

/**
 * `GET /admin/banners`: semua banner untuk admin, bisa disaring status.
 * @param req permintaan; query `status` diperiksa listBannersSchema
 * @param res jawaban `{ data: [banner] }`
 * @returns selesai setelah jawaban dikirim
 * @throws 400 status tidak dikenal
 */
export const listAdminBannersHandler: RequestHandler = async (req, res) => {
  res.json({ data: await listAdminBanners(parse(listBannersSchema, req.query).status) });
};
/**
 * `POST /admin/banners`: admin membuat banner platform yang langsung tayang.
 * @param req permintaan berisi isi banner
 * @param res jawaban 201 `{ data: banner }`
 * @returns selesai setelah jawaban dikirim
 * @throws 400 isian tidak valid
 */
export const createAdminBannerHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await createAdminBanner(getUserId(req), req.body) });
};
/**
 * `PATCH /admin/banners/:id`: admin meninjau banner (status, urutan, dan isi banner platform).
 * @param req permintaan dengan `:id` banner dan hasil tinjauan
 * @param res jawaban `{ data: banner }`
 * @returns selesai setelah jawaban dikirim
 * @throws 400 isian tidak valid, 404 banner tidak ada, 409 disetujui terlalu cepat setelah gambar diunggah
 */
export const reviewBannerHandler: RequestHandler = async (req, res) => {
  res.json({ data: await reviewBanner(getUserId(req), req.params.id, req.body) });
};

/**
 * `POST /admin/uploads`: membuat alamat unggah gambar banner atau pop-up platform ke folder `platform/<purpose>/`.
 * Isi permintaan sudah diperiksa adminUploadSchema di rute (`purpose` hanya `banner` atau `popup`).
 * @param req permintaan berisi `purpose`, `content_type`, dan `size`
 * @param res jawaban `{ data: { upload_url, public_url, expires_at } }`
 * @returns selesai setelah jawaban dikirim
 * @throws 503 penyimpanan gambar (R2) belum diatur di server
 */
export const uploadAdminHandler: RequestHandler = async (req, res) => {
  const { purpose, ...file } = req.body;
  res.json({ data: createUpload(`platform/${purpose}/`, file) });
};
