// Isi file: daftar route semua fitur penjual di bawah /api/v1/merchant: profil toko, menu dan kuota, unggah foto,
// banner, pesanan, laporan, promo, ulasan, asisten AI, meja, dan pencairan. Alurnya request masuk → middleware (login,
// peran penjual, pemeriksa body, pembatas laju) → handler → service → database.
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

// `validate(schema)` = memeriksa body dengan skema zod sebelum handler jalan (400 bila tidak sesuai). Pembatas laju
// (rate limiter) = penolak 429 bila satu pengguna terlalu sering memanggil route yang sama dalam waktu singkat.
/**
 * Router penjual. Dipasang di app.ts pada `/api/v1/merchant` dengan penjaga requireAuth + requireRole("merchant"), jadi
 * semua route di sini wajib login sebagai penjual. Toko selalu dicari dari token login, tidak pernah dari request.
 */
export const merchant = Router();

merchant.get("/profile", getProfileHandler);

merchant.patch("/status", validate(openStatusSchema), setOpenHandler);

merchant.patch("/profile", validate(updateProfileSchema), updateProfileHandler);

merchant.get("/menus", listMenusHandler);

merchant.get("/menus/:id", getMenuHandler);

merchant.post("/menus", validate(menuSchema), createMenuHandler);

merchant.patch("/menus/:id", validate(menuPatchSchema), updateMenuHandler);

merchant.delete("/menus/:id", deleteMenuHandler);

// body kuota diperiksa di handler supaya galat "tepat salah satu dari delta atau quota_today" tanpa `fields`
merchant.patch("/menus/:id/quota", updateQuotaHandler);

// alamat unggah foto: paling banyak 20 permintaan per penjual per 10 menit
merchant.post("/uploads", validate(merchantUploadSchema), uploadLimiter, uploadPhotoHandler);
// Banner beranda: satu banner aktif per toko, tampil setelah disetujui admin. Body diperiksa di service banner.
merchant.get("/banners", daftarBannerTokoHandler);
merchant.post("/banners", buatBannerTokoHandler);
merchant.patch("/banners/:id", ubahBannerTokoHandler);
merchant.delete("/banners/:id", hapusBannerTokoHandler);

// Daftar dan detail pesanan toko.
merchant.get("/orders", listMerchantOrdersHandler);

merchant.get("/orders/:code", getMerchantOrderHandler);

// Tautan chat WhatsApp ke pembeli.
merchant.get("/orders/:code/whatsapp", getMerchantOrderWhatsappHandler);

// Laporan penjualan.
merchant.get("/reports/summary", getReportSummaryHandler);

merchant.get("/reports/hourly", getHourlyReportHandler);

merchant.get("/reports/transactions", listReportTransactionsHandler);

// Promo toko. Body diperiksa di service promo.
merchant.get("/promos", listMerchantPromosHandler);

merchant.post("/promos", createMerchantPromoHandler);

merchant.patch("/promos/:id", updateMerchantPromoHandler);

merchant.delete("/promos/:id", deleteMerchantPromoHandler);

// Ulasan pembeli untuk menu toko.
merchant.get("/reviews", listMerchantReviewsHandler);

// Asisten AI toko: paling banyak 10 pertanyaan per penjual per 10 menit.
merchant.post("/assistant", validate(tanyaSchema), assistantLimiter, askAssistantHandler);

// Meja dan kode QR untuk pesan dari meja.
merchant.get("/tables", listTablesHandler);
merchant.post("/tables", validate(tableSchema), createTableHandler);
merchant.patch("/tables/:id", validate(updateTableSchema), updateTableHandler);

// Saldo dan riwayat pencairan, serta ubah rekening pencairan (kata sandi diminta ulang; lebih dari 5 kali ditolak 400
// dalam semenit → 429).
merchant.get("/payouts", pencairanSayaHandler);
merchant.put("/payout-account", validate(rekeningSchema), passwordLimiter, ubahRekeningHandler);

// Aksi penjual pada pesanan (confirm, cook, ready, complete, reject). Aksi lain diteruskan ke penangan 404.
merchant.post("/orders/:code/:aksi", transitionMerchantOrderHandler);
