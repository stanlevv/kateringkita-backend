// Isi file: handler HTTP panel admin untuk mengubah data penjual: tambah penjual, ubah profil toko dan akun pemilik,
// nonaktifkan/aktifkan akun, serta kelola menu toko. Lapisan kedua dari alur routes/admin.ts → handlers →
// admin-merchant-edit.service → database. Isi permintaan sudah diperiksa skema zod di routes/admin.ts.
import { RequestHandler } from "express";
import { menuQuerySchema } from "../dto/merchant-menu.dto";
import { AuthedRequest } from "../middleware/auth";
import { parse } from "../middleware/validate";
import {
  createMerchantByAdmin,
  createMerchantMenu,
  deleteMerchantMenu,
  getMerchantMenu,
  listMerchantMenus,
  setMerchantAccountActive,
  updateMerchantMenu,
  updateMerchantOwnerByAdmin,
  updateMerchantStoreByAdmin,
} from "../services/admin-merchant-edit.service";
import { parseMerchantId } from "./admin.handler";

const getAdminId = (req: unknown) => (req as AuthedRequest).auth.userId;

/** `POST /admin/merchants`: membuat akun pemilik dan toko (body sudah lolos registerMerchantSchema). Dijawab 201. */
export const createMerchantHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await createMerchantByAdmin(getAdminId(req), req.body) });
};

/** `PATCH /admin/merchants/:id`: mengubah profil toko; dijawab detail penjual sesudah diubah. */
export const updateMerchantStoreHandler: RequestHandler = async (req, res) => {
  res.json({ data: await updateMerchantStoreByAdmin(getAdminId(req), parseMerchantId(req.params.id), req.body) });
};

/** `PATCH /admin/merchants/:id/owner`: mengubah nama, nomor WA login, dan/atau email pemilik toko. */
export const updateMerchantOwnerHandler: RequestHandler = async (req, res) => {
  res.json({ data: await updateMerchantOwnerByAdmin(getAdminId(req), parseMerchantId(req.params.id), req.body) });
};

/**
 * Membuat handler `POST /admin/merchants/:id/account/activate` atau `/deactivate`.
 * @param active `true` untuk mengaktifkan, `false` untuk menonaktifkan
 * @returns handler yang menjawab `{ data }` berisi detail penjual sesudah diubah
 */
export const setMerchantAccountActiveHandler =
  (active: boolean): RequestHandler =>
  async (req, res) => {
    res.json({ data: await setMerchantAccountActive(getAdminId(req), parseMerchantId(req.params.id), active) });
  };

/** `GET /admin/merchants/:id/menus`: daftar menu toko; query sama dengan `GET /merchant/menus`. */
export const listMerchantMenusHandler: RequestHandler = async (req, res) => {
  res.json({ data: await listMerchantMenus(parseMerchantId(req.params.id), parse(menuQuerySchema, req.query)) });
};

/** `GET /admin/merchants/:id/menus/:menuId`: detail satu menu toko. */
export const getMerchantMenuHandler: RequestHandler = async (req, res) => {
  res.json({ data: await getMerchantMenu(parseMerchantId(req.params.id), req.params.menuId) });
};

/** `POST /admin/merchants/:id/menus`: menambah menu (body sudah lolos menuSchema). Dijawab 201. */
export const createMerchantMenuHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await createMerchantMenu(getAdminId(req), parseMerchantId(req.params.id), req.body) });
};

/** `PATCH /admin/merchants/:id/menus/:menuId`: mengubah sebagian data menu (body sudah lolos menuPatchSchema). */
export const updateMerchantMenuHandler: RequestHandler = async (req, res) => {
  res.json({
    data: await updateMerchantMenu(getAdminId(req), parseMerchantId(req.params.id), req.params.menuId, req.body),
  });
};

/** `DELETE /admin/merchants/:id/menus/:menuId`: menghapus menu secara lunak. Dijawab 204 tanpa isi. */
export const deleteMerchantMenuHandler: RequestHandler = async (req, res) => {
  await deleteMerchantMenu(getAdminId(req), parseMerchantId(req.params.id), req.params.menuId);
  res.status(204).end();
};
