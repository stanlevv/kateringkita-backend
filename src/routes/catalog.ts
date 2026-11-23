// Isi file: daftar route katalog publik, voucher/banner/pop-up publik, favorit, dan rekomendasi AI pembeli. Alurnya
// request masuk → middleware (login, peran, pemeriksa body, pembatas laju) → handler di file ini → service → database.
import { Router } from "express";
import {
  listFavoritesHandler,
  listFavoriteMerchantsHandler,
  listCatalogHandler,
  getMenuDetailHandler,
  deleteFavoriteHandler,
  deleteFavoriteMerchantHandler,
  getMerchantProfileHandler,
  saveFavoriteHandler,
  saveFavoriteMerchantHandler,
  recommendMenusHandler,
  listMenuReviewsHandler,
} from "../handlers/catalog.handler";
import { claimVoucherHandler, listPlatformVouchersHandler, listMyVouchersHandler } from "../handlers/voucher.handler";
import { listPublicBannersHandler } from "../handlers/banner.handler";
import { getPublicPopupHandler } from "../handlers/popup.handler";
import { recommendationSchema } from "../dto/recommendation.dto";
import { optionalAuth, requireAuth, requireRole } from "../middleware/auth";
import { assistantLimiter } from "../middleware/rate-limiter";
import { validate } from "../middleware/validate";

// `optionalAuth` = login boleh ada boleh tidak (tamu tetap dilayani); `requireAuth` + `requireRole("customer")` = wajib
// login sebagai pembeli.
/** Router katalog. Dipasang di app.ts pada `/api/v1`, sebelum router pesanan dan router auth. */
export const catalog = Router();

catalog.get("/menus", optionalAuth, listCatalogHandler);

catalog.get("/menus/:id", optionalAuth, getMenuDetailHandler);

catalog.get("/menus/:id/reviews", listMenuReviewsHandler);

catalog.get("/merchants/:slug", optionalAuth, getMerchantProfileHandler);

// Voucher: daftar voucher platform publik, klaim ke Voucher Saya, Voucher Saya (+ penanda bisa dipakai untuk checkout)
catalog.get("/vouchers/platform", optionalAuth, listPlatformVouchersHandler);
// Banner beranda yang tayang (maks 8); promo.claimed hanya untuk pembeli login
catalog.get("/banners", optionalAuth, listPublicBannersHandler);
// Pop-up promo yang tayang (atau null); promo.claimed hanya untuk pembeli login
catalog.get("/popup", optionalAuth, getPublicPopupHandler);
catalog.post("/me/vouchers/:id/claim", requireAuth, requireRole("customer"), claimVoucherHandler);
catalog.get("/me/vouchers", requireAuth, requireRole("customer"), listMyVouchersHandler);

catalog.get("/me/favorites", requireAuth, requireRole("customer"), listFavoritesHandler);

catalog.put("/me/favorites/:menuId", requireAuth, requireRole("customer"), saveFavoriteHandler);

catalog.delete("/me/favorites/:menuId", requireAuth, requireRole("customer"), deleteFavoriteHandler);

// Toko favorit ("Dapur Favorit"). Seperti favorit menu, tanpa pembatas laju: menyimpan atau menghapus berkali-kali
// hanya menyentuh satu baris yang sama, jadi hasilnya tetap sama.
catalog.get("/me/favorite-merchants", requireAuth, requireRole("customer"), listFavoriteMerchantsHandler);

catalog.put("/me/favorite-merchants/:merchantId", requireAuth, requireRole("customer"), saveFavoriteMerchantHandler);

catalog.delete(
  "/me/favorite-merchants/:merchantId",
  requireAuth,
  requireRole("customer"),
  deleteFavoriteMerchantHandler,
);

// Rekomendasi AI pembeli. Body diperiksa dulu, baru dihitung pembatas laju yang sama dengan asisten AI penjual:
// 10 permintaan per pengguna per 10 menit, karena setiap panggilan AI berbayar.
catalog.post(
  "/assistant/recommendations",
  requireAuth,
  requireRole("customer"),
  validate(recommendationSchema),
  assistantLimiter,
  recommendMenusHandler,
);
