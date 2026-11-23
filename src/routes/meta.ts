// Isi file: daftar alamat (rute) data referensi publik di /api/v1/meta: jenis usaha, kategori, titik temu, dan
// pengaturan umum. Lapisan pertama dari alur routes → handlers (meta.handler) → services (meta.service) → database.
import { Router } from "express";
import {
  listMerchantTypesHandler,
  listCategoriesHandler,
  listPickupPointsHandler,
  getSettingsHandler,
} from "../handlers/meta.handler";

/** Router data referensi; dipasang di /api/v1. Semua rute terbuka tanpa login. */
export const meta = Router();

meta.get("/meta/merchant-types", listMerchantTypesHandler);

meta.get("/meta/categories", listCategoriesHandler);

meta.get("/meta/pickup-points", listPickupPointsHandler);

meta.get("/meta/settings", getSettingsHandler);
