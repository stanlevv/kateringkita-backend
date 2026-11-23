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
import { klaimVoucherHandler, voucherPlatformHandler, voucherSayaHandler } from "../handlers/voucher.handler";
import { bannerPublikHandler } from "../handlers/banner.handler";
import { popupPublikHandler } from "../handlers/popup.handler";
import { recommendationSchema } from "../dto/recommendation.dto";
import { optionalAuth, requireAuth, requireRole } from "../middleware/auth";
import { assistantLimiter } from "../middleware/rate-limiter";
import { validate } from "../middleware/validate";

// Katalog publik (C-05, C-06, C-07) + favorit (C-19); dipasang di /api/v1 sebelum v1
export const catalog = Router();

catalog.get("/menus", optionalAuth, listCatalogHandler);

catalog.get("/menus/:id", optionalAuth, getMenuDetailHandler);

catalog.get("/menus/:id/reviews", listMenuReviewsHandler);

catalog.get("/merchants/:slug", optionalAuth, getMerchantProfileHandler);

// Voucher: daftar voucher platform publik, klaim ke Voucher Saya, Voucher Saya (+ penanda bisa dipakai untuk checkout)
catalog.get("/vouchers/platform", optionalAuth, voucherPlatformHandler);
// Banner beranda yang tayang (maks 8); promo.claimed hanya untuk pembeli login
catalog.get("/banners", optionalAuth, bannerPublikHandler);
// Pop-up promo yang tayang (atau null); promo.claimed hanya untuk pembeli login
catalog.get("/popup", optionalAuth, popupPublikHandler);
catalog.post("/me/vouchers/:id/claim", requireAuth, requireRole("customer"), klaimVoucherHandler);
catalog.get("/me/vouchers", requireAuth, requireRole("customer"), voucherSayaHandler);

catalog.get("/me/favorites", requireAuth, requireRole("customer"), listFavoritesHandler);

catalog.put("/me/favorites/:menuId", requireAuth, requireRole("customer"), saveFavoriteHandler);

catalog.delete("/me/favorites/:menuId", requireAuth, requireRole("customer"), deleteFavoriteHandler);

// F05 favorit toko ("Dapur Favorit"); tanpa pembatas laju, sama dengan favorit menu: tulis idempoten satu baris ber-PK
catalog.get("/me/favorite-merchants", requireAuth, requireRole("customer"), listFavoriteMerchantsHandler);

catalog.put("/me/favorite-merchants/:merchantId", requireAuth, requireRole("customer"), saveFavoriteMerchantHandler);

catalog.delete(
  "/me/favorite-merchants/:merchantId",
  requireAuth,
  requireRole("customer"),
  deleteFavoriteMerchantHandler,
);

// F24 rekomendasi AI pembeli (RAG); kuota bersama asisten AI: 10 per pengguna per 10 menit
catalog.post(
  "/assistant/recommendations",
  requireAuth,
  requireRole("customer"),
  validate(recommendationSchema),
  assistantLimiter,
  recommendMenusHandler,
);
