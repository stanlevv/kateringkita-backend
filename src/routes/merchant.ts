import { Router } from "express";
import { menuPatchSchema, menuSchema } from "../dto/merchant-menu.dto";
import { openStatusSchema, updateProfileSchema } from "../dto/merchant.dto";
import { merchantUploadSchema } from "../dto/upload.dto";
import {
  buatBannerTokoHandler,
  daftarBannerTokoHandler,
  hapusBannerTokoHandler,
  ubahBannerTokoHandler,
} from "../handlers/banner.handler";
import { tanyaSchema } from "../dto/asisten.dto";
import { tableSchema, updateTableSchema } from "../dto/table.dto";
import { rekeningSchema } from "../dto/pencairan.dto";
import { createTableHandler, listTablesHandler, updateTableHandler } from "../handlers/table.handler";
import { pencairanSayaHandler, ubahRekeningHandler } from "../handlers/pencairan.handler";
import {
  transitionMerchantOrderHandler,
  getMenuHandler,
  getMerchantOrderHandler,
  createMenuHandler,
  listMenusHandler,
  listMerchantOrdersHandler,
  createMerchantPromoHandler,
  listMerchantPromosHandler,
  listMerchantReviewsHandler,
  deleteMerchantPromoHandler,
  askAssistantHandler,
  updateMerchantPromoHandler,
  getProfileHandler,
  deleteMenuHandler,
  getHourlyReportHandler,
  listReportTransactionsHandler,
  getReportSummaryHandler,
  setOpenHandler,
  updateQuotaHandler,
  updateMenuHandler,
  updateProfileHandler,
  uploadPhotoHandler,
  getMerchantOrderWhatsappHandler,
} from "../handlers/merchant.handler";
import { assistantLimiter, passwordLimiter, uploadLimiter } from "../middleware/rate-limiter";
import { validate } from "../middleware/validate";

// Penjaga (requireAuth + requireRole("merchant")) dipasang sekali di app.ts; toko selalu dari token (R-10).
export const merchant = Router();

merchant.get("/profile", getProfileHandler);

merchant.patch("/status", validate(openStatusSchema), setOpenHandler);

merchant.patch("/profile", validate(updateProfileSchema), updateProfileHandler);

merchant.get("/menus", listMenusHandler);

merchant.get("/menus/:id", getMenuHandler);

merchant.post("/menus", validate(menuSchema), createMenuHandler);

merchant.patch("/menus/:id", validate(menuPatchSchema), updateMenuHandler);

merchant.delete("/menus/:id", deleteMenuHandler);

merchant.patch("/menus/:id/quota", updateQuotaHandler);

merchant.post("/uploads", validate(merchantUploadSchema), uploadLimiter, uploadPhotoHandler);
// Banner beranda (rancangan voucher 2026-11-16 §5.4): 1 banner aktif per toko, tampil setelah disetujui admin
merchant.get("/banners", daftarBannerTokoHandler);
merchant.post("/banners", buatBannerTokoHandler);
merchant.patch("/banners/:id", ubahBannerTokoHandler);
merchant.delete("/banners/:id", hapusBannerTokoHandler);

// F07 (M-04): daftar & detail pesanan toko
merchant.get("/orders", listMerchantOrdersHandler);

merchant.get("/orders/:code", getMerchantOrderHandler);

// F07 (M-04, M-11): tautan chat ke pembeli
merchant.get("/orders/:code/whatsapp", getMerchantOrderWhatsappHandler);

// F09 laporan penjualan
merchant.get("/reports/summary", getReportSummaryHandler);

merchant.get("/reports/hourly", getHourlyReportHandler);

merchant.get("/reports/transactions", listReportTransactionsHandler);

// F12 promo toko
merchant.get("/promos", listMerchantPromosHandler);

merchant.post("/promos", createMerchantPromoHandler);

merchant.patch("/promos/:id", updateMerchantPromoHandler);

merchant.delete("/promos/:id", deleteMerchantPromoHandler);

// F13 ulasan pembeli untuk menu toko
merchant.get("/reviews", listMerchantReviewsHandler);

// F17 asisten AI toko
merchant.post("/assistant", validate(tanyaSchema), assistantLimiter, askAssistantHandler);

// F21: meja & QR pesan dari meja
merchant.get("/tables", listTablesHandler);
merchant.post("/tables", validate(tableSchema), createTableHandler);
merchant.patch("/tables/:id", validate(updateTableSchema), updateTableHandler);

// F26: rekening pencairan (kata sandi diminta ulang, salah 5×/menit → 429), saldo & riwayat pencairan
merchant.get("/payouts", pencairanSayaHandler);
merchant.put("/payout-account", validate(rekeningSchema), passwordLimiter, ubahRekeningHandler);

// F07 (M-04, M-08): aksi di luar MERCHANT_ACTIONS → lanjut ke notFoundHandler (404)

merchant.post("/orders/:code/:aksi", transitionMerchantOrderHandler);
