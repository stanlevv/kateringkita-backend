// Isi file: handler HTTP untuk data referensi publik (tanpa login). Lapisan kedua dari alur routes/meta.ts →
// handlers → meta.service → database: tiap handler hanya memanggil service dan mengirim hasilnya sebagai `{ data }`.
import { RequestHandler } from "express";
import { getSettings, listMerchantTypes, listCategories, listPickupPoints } from "../services/meta.service";

/**
 * `GET /meta/merchant-types`: daftar jenis usaha aktif.
 * @param _req request masuk (tidak dibaca)
 * @param res  respons berisi `{ data: [...] }`
 * @returns Promise yang selesai setelah jawaban terkirim
 */
export const listMerchantTypesHandler: RequestHandler = async (_req, res) => {
  res.json({ data: await listMerchantTypes() });
};

/**
 * `GET /meta/categories`: daftar kategori menu aktif.
 * @param _req request masuk (tidak dibaca)
 * @param res  respons berisi `{ data: [...] }`
 * @returns Promise yang selesai setelah jawaban terkirim
 */
export const listCategoriesHandler: RequestHandler = async (_req, res) => {
  res.json({ data: await listCategories() });
};

/**
 * `GET /meta/pickup-points`: daftar titik temu aktif.
 * @param _req request masuk (tidak dibaca)
 * @param res  respons berisi `{ data: [...] }`
 * @returns Promise yang selesai setelah jawaban terkirim
 */
export const listPickupPointsHandler: RequestHandler = async (_req, res) => {
  res.json({ data: await listPickupPoints() });
};

/**
 * `GET /meta/settings`: pengaturan umum (biaya layanan, zona waktu, WhatsApp layanan pelanggan, mode pemeliharaan).
 * @param _req request masuk (tidak dibaca)
 * @param res  respons berisi `{ data: { service_fee, timezone, cs_whatsapp, maintenance } }`
 * @returns Promise yang selesai setelah jawaban terkirim
 */
export const getSettingsHandler: RequestHandler = async (_req, res) => {
  res.json({ data: await getSettings() });
};
