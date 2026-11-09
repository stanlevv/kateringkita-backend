import { Router } from "express";
import {
  daftarFavoritHandler, daftarKatalogHandler, detailMenuHandler, hapusFavoritHandler, profilTokoHandler, simpanFavoritHandler,
  rekomendasiHandler, ulasanMenuHandler,
} from "../handlers/katalog.handler";
import { rekomendasiSchema } from "../dto/rekomendasi.dto";
import { authOpsional, requireAuth, requireRole } from "../middleware/auth";
import { asistenLimiter } from "../middleware/rateLimiter";
import { validate } from "../middleware/validate";

// Katalog publik (C-05, C-06, C-07) + favorit (C-19); dipasang di /api/v1 sebelum v1
export const katalog = Router();

katalog.get("/menus", authOpsional, daftarKatalogHandler);

katalog.get("/menus/:id", authOpsional, detailMenuHandler);

katalog.get("/menus/:id/reviews", ulasanMenuHandler);

katalog.get("/merchants/:slug", profilTokoHandler);

katalog.get("/me/favorites", requireAuth, requireRole("customer"), daftarFavoritHandler);

katalog.put("/me/favorites/:menuId", requireAuth, requireRole("customer"), simpanFavoritHandler);

katalog.delete("/me/favorites/:menuId", requireAuth, requireRole("customer"), hapusFavoritHandler);

// F24 rekomendasi AI pembeli (RAG); kuota bersama asisten AI: 10 per pengguna per 10 menit
katalog.post("/assistant/recommendations", requireAuth, requireRole("customer"), validate(rekomendasiSchema), asistenLimiter, rekomendasiHandler);
