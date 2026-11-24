// Isi file: daftar alamat (rute) panel admin di /api/v1/admin. Lapisan pertama dari alur routes → handlers →
// services → database. Sebelum masuk ke sini, app.ts sudah memasang requireAuth (wajib login), requireRole("admin"),
// dan adminAccess (middleware/admin-access.ts) yang membatasi menurut tingkat admin:
// - super: semua rute;
// - ops: semua rute kecuali yang khusus super, yaitu /admins, /ai-*, /finance, /payouts, /refunds, /server-*, dan
//   mengubah /settings;
// - support: hanya membaca (GET) di luar rute khusus super, ditambah membalas dan menutup tiket (/tickets).
// Di file ini dipasang pemeriksa isi permintaan (validate dengan skema zod) sebelum handler.
import { RequestHandler, Router } from "express";
import {
  createAdminSchema,
  removePhotoSchema,
  csContactSchema,
  updateAdminLevelSchema,
  maintenanceSchema,
  announcementSchema,
  adminReasonSchema,
} from "../dto/admin.dto";
import {
  merchantActionHandler,
  getSettingsHandler,
  getVerificationQueueHandler,
  createMasterDataHandler,
  createPromoHandler,
  listAuditLogsHandler,
  listMasterDataHandler,
  listMerchantsHandler,
  listPromosHandler,
  getMerchantDetailHandler,
  parseMerchantId,
  getSummaryHandler,
  getQueuesHandler,
  setMasterActiveHandler,
  setPromoActiveHandler,
  setPromoArchivedHandler,
  updateServiceFeeHandler,
  updateMasterDataHandler,
  updatePromoHandler,
  listAdminMenusHandler,
  listAdminReviewsHandler,
  removeMenuPhotoHandler,
  sendAnnouncementHandler,
  moderateMenuHandler,
  moderateReviewHandler,
  getFinanceSummaryHandler,
  updateCsContactHandler,
  updateMaintenanceHandler,
  listAdminsHandler,
  createAdminHandler,
  updateAdminLevelHandler,
  setAdminActiveHandler,
  resetAdminPasswordHandler,
} from "../handlers/admin.handler";
import { aiProviderSchema, updateAiProviderSchema } from "../dto/ai.dto";
import { verifyAiResultSchema } from "../dto/ai-result.dto";
import { adminUploadSchema } from "../dto/upload.dto";
import {
  createAdminBannerHandler,
  listAdminBannersHandler,
  reviewBannerHandler,
  setBannerArchivedHandler,
  updateAdminBannerContentHandler,
  uploadAdminHandler,
} from "../handlers/banner.handler";
import {
  createPopupHandler,
  listPopupsHandler,
  setPopupArchivedHandler,
  updatePopupHandler,
} from "../handlers/popup.handler";
import { uploadLimiter } from "../middleware/rate-limiter";
import { listAiResultsHandler, verifyAiResultHandler } from "../handlers/ai-result.handler";
import {
  createAiProviderHandler,
  listAiProvidersHandler,
  deleteAiProviderHandler,
  getAiUsageHandler,
  updateAiProviderHandler,
  testAiProviderHandler,
} from "../handlers/ai.handler";
import { listServerLogsHandler, getServerStatusHandler } from "../handlers/server-log.handler";
import { payoutSchema, refundSchema } from "../dto/payout.dto";
import {
  recordPayoutHandler,
  listRefundsHandler,
  listBalancesHandler,
  listPayoutHistoryHandler,
  markRefundedHandler,
} from "../handlers/payout.handler";
import {
  replyAdminTicketHandler,
  listAdminTicketsHandler,
  getAdminTicketHandler,
  closeAdminTicketHandler,
} from "../handlers/ticket.handler";
import { getChatReportHandler, listChatReportsHandler } from "../handlers/order-chat.handler";
import { validate } from "../middleware/validate";
import { adminAccountUpdateSchema } from "../dto/admin-user.dto";
import { registerCustomerSchema, registerMerchantSchema } from "../dto/auth.dto";
import { updateProfileSchema } from "../dto/merchant.dto";
import { menuPatchSchema, menuSchema } from "../dto/merchant-menu.dto";
import {
  createCustomerHandler,
  getCustomerDetailHandler,
  listCustomersHandler,
  setCustomerActiveHandler,
  updateCustomerHandler,
} from "../handlers/admin-customer.handler";
import {
  createMerchantHandler,
  createMerchantMenuHandler,
  deleteMerchantMenuHandler,
  getMerchantMenuHandler,
  listMerchantMenusHandler,
  setMerchantAccountActiveHandler,
  updateMerchantMenuHandler,
  updateMerchantOwnerHandler,
  updateMerchantStoreHandler,
} from "../handlers/admin-merchant-edit.handler";
import { parseCustomerId } from "../services/admin-customer.service";
import { ACTION_NAMES } from "../services/admin-merchant.service";
import { AppError } from "../utils/errors";

/** Router panel admin; dipasang di app.ts pada /api/v1/admin setelah penjaga login, peran, dan tingkat admin. */
export const admin = Router();

// Memasang pasangan rute POST <path>/activate (handler(true)) dan POST <path>/deactivate (handler(false)); dengan
// `names` lain, contoh ARCHIVE_ROUTES, nama kedua rutenya mengikuti.
const toggle = (
  path: string,
  handler: (active: boolean) => RequestHandler,
  names: readonly [string, string] = ["activate", "deactivate"],
) => {
  admin.post(`${path}/${names[0]}`, handler(true));
  admin.post(`${path}/${names[1]}`, handler(false));
};
// Arsip konten admin: POST <path>/archive (handler(true)) dan POST <path>/restore (handler(false)).
const ARCHIVE_ROUTES = ["archive", "restore"] as const;

// Log audit: catatan setiap perubahan yang dilakukan admin.
admin.get("/audit-logs", listAuditLogsHandler);

// Kelola akun admin (khusus super; lihat middleware/admin-access.ts).
admin.get("/admins", listAdminsHandler);
admin.post("/admins", validate(createAdminSchema), createAdminHandler);
admin.patch("/admins/:id/level", validate(updateAdminLevelSchema), updateAdminLevelHandler);
toggle("/admins/:id", setAdminActiveHandler);
admin.post("/admins/:id/reset-password", resetAdminPasswordHandler);

// Penjual: daftar, antrean verifikasi, detail, dan aksi status.
admin.get("/merchants", listMerchantsHandler);

admin.get("/verification-queue", getVerificationQueueHandler);

admin.get("/merchants/:id", getMerchantDetailHandler);

// id dicek sebelum isi permintaan: id tidak valid dijawab 404 walaupun isinya kosong.
const checkMerchantId: RequestHandler = (req, _res, next) => {
  parseMerchantId(req.params.id);
  next();
};
// Satu rute per aksi; minta perbaikan dan tangguhkan wajib menyertakan alasan.
for (const name of ACTION_NAMES) {
  const needsReason = name === "request-fix" || name === "suspend";
  admin.post(
    `/merchants/:id/${name}`,
    checkMerchantId,
    ...(needsReason ? [validate(adminReasonSchema)] : []),
    merchantActionHandler(name),
  );
}

// Penjual: tambah, ubah profil toko dan akun pemilik, nonaktifkan/aktifkan akun, dan kelola menu toko. Aturan isinya
// sama dengan yang dipakai penjual sendiri (skema pendaftaran, profil toko, dan menu).
admin.post("/merchants", validate(registerMerchantSchema), createMerchantHandler);
admin.patch("/merchants/:id", checkMerchantId, validate(updateProfileSchema), updateMerchantStoreHandler);
admin.patch("/merchants/:id/owner", checkMerchantId, validate(adminAccountUpdateSchema), updateMerchantOwnerHandler);
toggle("/merchants/:id/account", setMerchantAccountActiveHandler);
admin.get("/merchants/:id/menus", listMerchantMenusHandler);
admin.get("/merchants/:id/menus/:menuId", getMerchantMenuHandler);
admin.post("/merchants/:id/menus", checkMerchantId, validate(menuSchema), createMerchantMenuHandler);
admin.patch("/merchants/:id/menus/:menuId", checkMerchantId, validate(menuPatchSchema), updateMerchantMenuHandler);
admin.delete("/merchants/:id/menus/:menuId", deleteMerchantMenuHandler);

// Pembeli: daftar, detail, tambah, ubah, dan nonaktifkan/aktifkan akun.
const checkCustomerId: RequestHandler = (req, _res, next) => {
  parseCustomerId(req.params.id);
  next();
};
admin.get("/customers", listCustomersHandler);
admin.get("/customers/:id", getCustomerDetailHandler);
admin.post("/customers", validate(registerCustomerSchema), createCustomerHandler);
admin.patch("/customers/:id", checkCustomerId, validate(adminAccountUpdateSchema), updateCustomerHandler);
toggle("/customers/:id", setCustomerActiveHandler);

// Data master: :kind = categories, pickup-points, atau merchant-types.
admin.get("/master/:kind", listMasterDataHandler);
admin.post("/master/:kind", createMasterDataHandler);
admin.patch("/master/:kind/:id", updateMasterDataHandler);
toggle("/master/:kind/:id", setMasterActiveHandler);

// Promo platform (termasuk arsip dan pulihkan), pengaturan aplikasi (mengubahnya khusus super), pengumuman,
// ringkasan beranda, dan hitungan antrean "Perlu tindakan" (semua tingkat; dua hitungan uang hanya untuk super).
admin.get("/promos", listPromosHandler);
admin.post("/promos", createPromoHandler);
admin.patch("/promos/:id", updatePromoHandler);
toggle("/promos/:id", setPromoActiveHandler);
toggle("/promos/:id", setPromoArchivedHandler, ARCHIVE_ROUTES);
admin.get("/settings", getSettingsHandler);
admin.put("/settings/service-fee", updateServiceFeeHandler);
admin.put("/settings/cs-contact", validate(csContactSchema), updateCsContactHandler);
admin.put("/settings/maintenance", validate(maintenanceSchema), updateMaintenanceHandler);
admin.post("/broadcasts", validate(announcementSchema), sendAnnouncementHandler);
admin.get("/summary", getSummaryHandler);
admin.get("/queues", getQueuesHandler);

// Rekap keuangan per toko.
admin.get("/finance", getFinanceSummaryHandler);

// Pencairan dana Midtrans ke penjual dan pengembalian dana (refund) pesanan batal yang sudah lunas.
admin.get("/payouts/balances", listBalancesHandler);
admin.get("/payouts", listPayoutHistoryHandler);
admin.post("/payouts", validate(payoutSchema), recordPayoutHandler);
admin.get("/refunds", listRefundsHandler);
admin.post("/refunds/:code", validate(refundSchema), markRefundedHandler);

// Moderasi ulasan dan menu (menangguhkan toko lewat /merchants/:id/suspend); sembunyikan dan turunkan wajib
// beralasan.
admin.get("/reviews", listAdminReviewsHandler);
admin.post("/reviews/:id/hide", validate(adminReasonSchema), moderateReviewHandler(true));
admin.post("/reviews/:id/unhide", moderateReviewHandler(false));
admin.get("/menus", listAdminMenusHandler);
admin.post("/menus/:id/takedown", validate(adminReasonSchema), moderateMenuHandler(true));
admin.post("/menus/:id/restore", moderateMenuHandler(false));
admin.post("/menus/:id/photos/remove", validate(removePhotoSchema), removeMenuPhotoHandler);

// AI gateway: penyedia AI, urutan fallback, uji koneksi.
admin.get("/ai-providers", listAiProvidersHandler);
admin.post("/ai-providers", validate(aiProviderSchema), createAiProviderHandler);
admin.patch("/ai-providers/:id", validate(updateAiProviderSchema), updateAiProviderHandler);
admin.delete("/ai-providers/:id", deleteAiProviderHandler);
admin.post("/ai-providers/:id/test", testAiProviderHandler);
// Pemakaian AI: token, panggilan, gagal, latensi.
admin.get("/ai-usage", getAiUsageHandler);
// Banner beranda: semua tingkat admin melihat; super dan ops membuat, meninjau, mengubah isi banner platform, serta
// mengarsipkan dan memulihkan. Unggah gambar platform untuk banner dan pop-up.
admin.get("/banners", listAdminBannersHandler);
admin.post("/banners", createAdminBannerHandler);
admin.patch("/banners/:id", reviewBannerHandler);
admin.patch("/banners/:id/content", updateAdminBannerContentHandler);
toggle("/banners/:id", setBannerArchivedHandler, ARCHIVE_ROUTES);
admin.post("/uploads", validate(adminUploadSchema), uploadLimiter, uploadAdminHandler);
// Pop-up promo aplikasi mobile: semua tingkat melihat; super dan ops membuat, mengubah, mengarsipkan, dan memulihkan.
admin.get("/popups", listPopupsHandler);
admin.post("/popups", createPopupHandler);
admin.patch("/popups/:id", updatePopupHandler);
toggle("/popups/:id", setPopupArchivedHandler, ARCHIVE_ROUTES);
// Hasil AI tersimpan diperiksa manual: ops dan super memberi keputusan, support hanya melihat. Path-nya /hasil-ai,
// tidak berawalan "ai-", jadi tidak termasuk rute khusus super.
admin.get("/hasil-ai", listAiResultsHandler);
admin.patch("/hasil-ai/:id", validate(verifyAiResultSchema), verifyAiResultHandler);

// Dasbor server: status, galat 5xx, dan request lambat.
admin.get("/server-status", getServerStatusHandler);
admin.get("/server-logs", listServerLogsHandler);

// Tiket bantuan (CS) dari pembeli; semua tingkat admin boleh membaca, membalas, dan menutup.
admin.get("/tickets", listAdminTicketsHandler);
admin.get("/tickets/:code", getAdminTicketHandler);
admin.post("/tickets/:code/messages", replyAdminTicketHandler);
admin.post("/tickets/:code/close", closeAdminTicketHandler);

// Chat pesanan yang dilaporkan pembeli atau penjual; semua tingkat admin boleh membaca, tidak ada rute untuk menulis.
// Hanya chat yang dilaporkan yang bisa dibaca, lewat laporannya.
admin.get("/chat-reports", listChatReportsHandler);
admin.get("/chat-reports/:id", getChatReportHandler);

// Path admin yang tidak dikenal berhenti di sini (404), tidak diteruskan ke router /api/v1 lain.
admin.use(() => {
  throw new AppError(404, "NOT_FOUND", "Data tidak ditemukan.");
});
