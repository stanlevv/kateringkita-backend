import { Router } from "express";
import {
  daftarFavoritHandler,
  daftarFavoritTokoHandler,
  daftarKatalogHandler,
  detailMenuHandler,
  hapusFavoritHandler,
  hapusFavoritTokoHandler,
  profilTokoHandler,
  simpanFavoritHandler,
  simpanFavoritTokoHandler,
  rekomendasiHandler,
  ulasanMenuHandler,
} from "../handlers/katalog.handler";
import { klaimVoucherHandler, voucherPlatformHandler, voucherSayaHandler } from "../handlers/voucher.handler";
import { bannerPublikHandler } from "../handlers/banner.handler";
import { popupPublikHandler } from "../handlers/popup.handler";
import { rekomendasiSchema } from "../dto/rekomendasi.dto";
import { authOpsional, requireAuth, requireRole } from "../middleware/auth";
import { asistenLimiter } from "../middleware/rate-limiter";
import { validate } from "../middleware/validate";

// Katalog publik (C-05, C-06, C-07) + favorit (C-19); dipasang di /api/v1 sebelum v1
export const katalog = Router();

katalog.get("/menus", authOpsional, daftarKatalogHandler);

katalog.get("/menus/:id", authOpsional, detailMenuHandler);

katalog.get("/menus/:id/reviews", ulasanMenuHandler);

katalog.get("/merchants/:slug", authOpsional, profilTokoHandler);

// Voucher: daftar voucher platform publik, klaim ke Voucher Saya, Voucher Saya (+ penanda bisa dipakai untuk checkout)
katalog.get("/vouchers/platform", authOpsional, voucherPlatformHandler);
// Banner beranda yang tayang (maks 8); promo.claimed hanya untuk pembeli login
katalog.get("/banners", authOpsional, bannerPublikHandler);
// Pop-up promo yang tayang (atau null); promo.claimed hanya untuk pembeli login
katalog.get("/popup", authOpsional, popupPublikHandler);
katalog.post("/me/vouchers/:id/claim", requireAuth, requireRole("customer"), klaimVoucherHandler);
katalog.get("/me/vouchers", requireAuth, requireRole("customer"), voucherSayaHandler);

katalog.get("/me/favorites", requireAuth, requireRole("customer"), daftarFavoritHandler);

katalog.put("/me/favorites/:menuId", requireAuth, requireRole("customer"), simpanFavoritHandler);

katalog.delete("/me/favorites/:menuId", requireAuth, requireRole("customer"), hapusFavoritHandler);

// F05 favorit toko ("Dapur Favorit"); tanpa pembatas laju, sama dengan favorit menu: tulis idempoten satu baris ber-PK
katalog.get("/me/favorite-merchants", requireAuth, requireRole("customer"), daftarFavoritTokoHandler);

katalog.put("/me/favorite-merchants/:merchantId", requireAuth, requireRole("customer"), simpanFavoritTokoHandler);

katalog.delete("/me/favorite-merchants/:merchantId", requireAuth, requireRole("customer"), hapusFavoritTokoHandler);

// F24 rekomendasi AI pembeli (RAG); kuota bersama asisten AI: 10 per pengguna per 10 menit
katalog.post(
  "/assistant/recommendations",
  requireAuth,
  requireRole("customer"),
  validate(rekomendasiSchema),
  asistenLimiter,
  rekomendasiHandler,
);
