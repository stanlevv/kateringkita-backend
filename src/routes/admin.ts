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
  setMasterActiveHandler,
  setPromoActiveHandler,
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
  uploadAdminHandler,
} from "../handlers/banner.handler";
import { createPopupHandler, listPopupsHandler, updatePopupHandler } from "../handlers/popup.handler";
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
import { validate } from "../middleware/validate";
import { ACTION_NAMES } from "../services/admin-merchant.service";
import { AppError } from "../utils/errors";

// Penjaga (requireAuth + requireRole("admin")) dipasang sekali di app.ts.
export const admin = Router();

// POST <path>/activate dan <path>/deactivate
const toggle = (path: string, handler: (active: boolean) => RequestHandler) => {
  for (const [action, active] of [
    ["activate", true],
    ["deactivate", false],
  ] as const) {
    admin.post(`${path}/${action}`, handler(active));
  }
};

admin.get("/audit-logs", listAuditLogsHandler);

// Fase 1 kelola admin (khusus super; lihat middleware/admin-access.ts)
admin.get("/admins", listAdminsHandler);
admin.post("/admins", validate(createAdminSchema), createAdminHandler);
admin.patch("/admins/:id/level", validate(updateAdminLevelSchema), updateAdminLevelHandler);
toggle("/admins/:id", setAdminActiveHandler);
admin.post("/admins/:id/reset-password", resetAdminPasswordHandler);

admin.get("/merchants", listMerchantsHandler);

admin.get("/verification-queue", getVerificationQueueHandler);

admin.get("/merchants/:id", getMerchantDetailHandler);

// id dicek sebelum body: id tak valid → 404 walau body kosong
const checkMerchantId: RequestHandler = (req, _res, next) => {
  parseMerchantId(req.params.id);
  next();
};
for (const name of ACTION_NAMES) {
  const needsReason = name === "request-fix" || name === "suspend";
  admin.post(
    `/merchants/:id/${name}`,
    checkMerchantId,
    ...(needsReason ? [validate(adminReasonSchema)] : []),
    merchantActionHandler(name),
  );
}

admin.get("/master/:kind", listMasterDataHandler);
admin.post("/master/:kind", createMasterDataHandler);
admin.patch("/master/:kind/:id", updateMasterDataHandler);
toggle("/master/:kind/:id", setMasterActiveHandler);

admin.get("/promos", listPromosHandler);
admin.post("/promos", createPromoHandler);
admin.patch("/promos/:id", updatePromoHandler);
toggle("/promos/:id", setPromoActiveHandler);
admin.get("/settings", getSettingsHandler);
admin.put("/settings/service-fee", updateServiceFeeHandler);
admin.put("/settings/cs-contact", validate(csContactSchema), updateCsContactHandler);
admin.put("/settings/maintenance", validate(maintenanceSchema), updateMaintenanceHandler);
admin.post("/broadcasts", validate(announcementSchema), sendAnnouncementHandler);
admin.get("/summary", getSummaryHandler);

// F20 rekap keuangan per toko
admin.get("/finance", getFinanceSummaryHandler);

// F26 pencairan dana Midtrans ke penjual & pengembalian dana pesanan batal yang sudah lunas
admin.get("/payouts/balances", listBalancesHandler);
admin.get("/payouts", listPayoutHistoryHandler);
admin.post("/payouts", validate(payoutSchema), recordPayoutHandler);
admin.get("/refunds", listRefundsHandler);
admin.post("/refunds/:code", validate(refundSchema), markRefundedHandler);

// F19 moderasi ulasan & menu (suspend toko: /merchants/:id/suspend)
admin.get("/reviews", listAdminReviewsHandler);
admin.post("/reviews/:id/hide", validate(adminReasonSchema), moderateReviewHandler(true));
admin.post("/reviews/:id/unhide", moderateReviewHandler(false));
admin.get("/menus", listAdminMenusHandler);
admin.post("/menus/:id/takedown", validate(adminReasonSchema), moderateMenuHandler(true));
admin.post("/menus/:id/restore", moderateMenuHandler(false));
admin.post("/menus/:id/photos/remove", validate(removePhotoSchema), removeMenuPhotoHandler);

// F22 AI gateway: penyedia AI, urutan fallback, uji koneksi
admin.get("/ai-providers", listAiProvidersHandler);
admin.post("/ai-providers", validate(aiProviderSchema), createAiProviderHandler);
admin.patch("/ai-providers/:id", validate(updateAiProviderSchema), updateAiProviderHandler);
admin.delete("/ai-providers/:id", deleteAiProviderHandler);
admin.post("/ai-providers/:id/test", testAiProviderHandler);
// F25 pemakaian AI: token, panggilan, gagal, latensi
admin.get("/ai-usage", getAiUsageHandler);
// Banner beranda (rancangan voucher 2026-11-16 §5.4): semua tingkat melihat, super & ops memutuskan; unggah gambar platform
admin.get("/banners", listAdminBannersHandler);
admin.post("/banners", createAdminBannerHandler);
admin.patch("/banners/:id", reviewBannerHandler);
admin.post("/uploads", validate(adminUploadSchema), uploadLimiter, uploadAdminHandler);
// Pop-up promo mobile: semua tingkat melihat, super & ops membuat / mengubah
admin.get("/popups", listPopupsHandler);
admin.post("/popups", createPopupHandler);
admin.patch("/popups/:id", updatePopupHandler);
// Rubrik AI: hasil AI tersimpan diverifikasi manual (ops & super; support hanya melihat — bukan path "ai-" khusus super)
admin.get("/hasil-ai", listAiResultsHandler);
admin.patch("/hasil-ai/:id", validate(verifyAiResultSchema), verifyAiResultHandler);

// F23 dashboard server: status, error 5xx & request lambat
admin.get("/server-status", getServerStatusHandler);
admin.get("/server-logs", listServerLogsHandler);

// Tiket bantuan (CS) dari pembeli; semua tingkat admin boleh baca, balas, tutup (lihat middleware/admin-access.ts)
admin.get("/tickets", listAdminTicketsHandler);
admin.get("/tickets/:code", getAdminTicketHandler);
admin.post("/tickets/:code/messages", replyAdminTicketHandler);
admin.post("/tickets/:code/close", closeAdminTicketHandler);

// path admin tak dikenal berhenti di sini (404), tidak jatuh ke router v1
admin.use(() => {
  throw new AppError(404, "NOT_FOUND", "Data tidak ditemukan.");
});
