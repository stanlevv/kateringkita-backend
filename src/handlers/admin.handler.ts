import { RequestHandler } from "express";
import { AuthedRequest } from "../middleware/auth";
import { listAuditLogs, parseLogFilter } from "../services/admin-audit.service";
import { createMasterData, listMasterData, setMasterActive, updateMasterData } from "../services/admin-master.service";
import {
  getVerificationQueue,
  listMerchants,
  getMerchantDetail,
  runMerchantAction,
} from "../services/admin-merchant.service";
import {
  getServiceFee,
  getCsContact,
  createPromo,
  listPromos,
  setPromoActive,
  updateServiceFee,
  updateCsContact,
  updatePromo,
} from "../services/admin-promo.service";
import { sendAnnouncement } from "../services/admin-announcement.service";
import { getAdminSummary } from "../services/admin-summary.service";
import { getFinanceSummary } from "../services/admin-finance.service";
import { adminRangeSchema } from "../dto/merchant-report.dto";
import { parse } from "../middleware/validate";
import {
  listAdminMenus,
  listAdminReviews,
  removeMenuPhoto,
  moderateMenu,
  moderateReview,
} from "../services/admin-moderation.service";
import {
  createAdmin,
  listAdmins,
  resetAdminPassword,
  setAdminActive,
  updateAdminLevel,
} from "../services/admin-account.service";
import { AppError } from "../utils/errors";
import { getMaintenance, updateMaintenance } from "../services/maintenance.service";

const toPositiveInt = (value: unknown, fallback: number, max: number) => {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(parsed, max) : fallback;
};
export const parseMerchantId = (value: unknown) => {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw new AppError(404, "NOT_FOUND", "Penjual tidak ditemukan.");
  return id;
};
const asString = (value: unknown) => (typeof value === "string" ? value : undefined);
const getAdminId = (req: unknown) => (req as AuthedRequest).auth.userId;

export const listAuditLogsHandler: RequestHandler = async (req, res) => {
  res.json(
    await listAuditLogs(
      parseLogFilter(req.query, toPositiveInt(req.query.page, 1, 1e6), toPositiveInt(req.query.limit, 20, 100)),
    ),
  );
};

export const listMerchantsHandler: RequestHandler = async (req, res) => {
  const { q: search, status, open } = req.query;
  res.json(
    await listMerchants({
      q: asString(search)?.trim(),
      status: asString(status),
      open: asString(open),
      page: toPositiveInt(req.query.page, 1, 1e6),
      limit: toPositiveInt(req.query.limit, 20, 100),
    }),
  );
};

export const getVerificationQueueHandler: RequestHandler = async (_req, res) => {
  res.json({ data: await getVerificationQueue() });
};

export const getMerchantDetailHandler: RequestHandler = async (req, res) => {
  res.json({ data: await getMerchantDetail(parseMerchantId(req.params.id)) });
};

// POST /merchants/:id/<name>, satu route per ACTION_NAMES
export const merchantActionHandler =
  (name: string): RequestHandler =>
  async (req, res) => {
    res.json({
      data: await runMerchantAction(getAdminId(req), parseMerchantId(req.params.id), name, req.body?.reason),
    });
  };

// Tipe params sama dengan yang diturunkan Express dari path "/master/:kind" dan "/master/:kind/:id"
export const listMasterDataHandler: RequestHandler<{ kind: string }> = async (req, res) => {
  res.json({ data: await listMasterData(req.params.kind) });
};
export const createMasterDataHandler: RequestHandler<{ kind: string }> = async (req, res) => {
  res.status(201).json({ data: await createMasterData(getAdminId(req), req.params.kind, req.body) });
};
export const updateMasterDataHandler: RequestHandler<{ kind: string; id: string }> = async (req, res) => {
  res.json({ data: await updateMasterData(getAdminId(req), req.params.kind, req.params.id, req.body) });
};
// POST .../activate (aktif = true) dan .../deactivate (aktif = false)
export const setMasterActiveHandler =
  (active: boolean): RequestHandler =>
  async (req, res) => {
    res.json({ data: await setMasterActive(getAdminId(req), String(req.params.kind), req.params.id, active) });
  };

export const listPromosHandler: RequestHandler = async (_req, res) => {
  res.json({ data: await listPromos() });
};
export const createPromoHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await createPromo(getAdminId(req), req.body) });
};
export const updatePromoHandler: RequestHandler = async (req, res) => {
  res.json({ data: await updatePromo(getAdminId(req), req.params.id, req.body) });
};
// POST .../activate (aktif = true) dan .../deactivate (aktif = false)
export const setPromoActiveHandler =
  (active: boolean): RequestHandler =>
  async (req, res) => {
    res.json({ data: await setPromoActive(getAdminId(req), req.params.id, active) });
  };
export const getSettingsHandler: RequestHandler = async (_req, res) => {
  res.json({
    data: {
      service_fee: await getServiceFee(),
      cs_whatsapp: await getCsContact(),
      maintenance: await getMaintenance(),
    },
  });
};
// F27 (body divalidasi pemeliharaanSchema)
export const updateMaintenanceHandler: RequestHandler = async (req, res) => {
  res.json({ data: { maintenance: await updateMaintenance(getAdminId(req), req.body) } });
};
export const updateServiceFeeHandler: RequestHandler = async (req, res) => {
  res.json({ data: await updateServiceFee(getAdminId(req), req.body) });
};
export const getSummaryHandler: RequestHandler = async (_req, res) => {
  res.json({ data: await getAdminSummary() });
};

// F19 moderasi: ?q=&status=active|moderated&page&limit; alasan wajib untuk hide/takedown (reasonBody di rute)
const parseModerationFilter = (query: Record<string, unknown>) => ({
  q: asString(query.q)?.trim() || undefined,
  status: asString(query.status),
  page: toPositiveInt(query.page, 1, 1e6),
  limit: toPositiveInt(query.limit, 20, 100),
});
export const listAdminReviewsHandler: RequestHandler = async (req, res) => {
  res.json(await listAdminReviews(parseModerationFilter(req.query)));
};
export const moderateReviewHandler =
  (hide: boolean): RequestHandler =>
  async (req, res) => {
    res.json({ data: await moderateReview(getAdminId(req), req.params.id, hide, hide ? req.body.reason : null) });
  };
export const listAdminMenusHandler: RequestHandler = async (req, res) => {
  res.json(await listAdminMenus(parseModerationFilter(req.query)));
};
export const moderateMenuHandler =
  (takedown: boolean): RequestHandler =>
  async (req, res) => {
    res.json({ data: await moderateMenu(getAdminId(req), req.params.id, takedown, takedown ? req.body.reason : null) });
  };
export const removeMenuPhotoHandler: RequestHandler = async (req, res) => {
  res.json({ data: await removeMenuPhoto(getAdminId(req), req.params.id, req.body.url, req.body.reason) });
};

// F20 rekap keuangan ?from&to (tanggal WIB, maks 92 hari)
export const getFinanceSummaryHandler: RequestHandler = async (req, res) => {
  res.json({ data: await getFinanceSummary(parse(adminRangeSchema, req.query)) });
};

// Kontak CS (body divalidasi kontakCsSchema) dan broadcast pengumuman (pengumumanSchema)
export const updateCsContactHandler: RequestHandler = async (req, res) => {
  res.json({ data: await updateCsContact(getAdminId(req), req.body.wa_number) });
};
export const sendAnnouncementHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await sendAnnouncement(getAdminId(req), req.body) });
};

// Fase 1 kelola admin (khusus super, dijaga adminAccess)
export const listAdminsHandler: RequestHandler = async (_req, res) => {
  res.json({ data: await listAdmins() });
};
export const createAdminHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await createAdmin(getAdminId(req), req.body) });
};
export const updateAdminLevelHandler: RequestHandler = async (req, res) => {
  res.json({ data: await updateAdminLevel(getAdminId(req), req.params.id, req.body.admin_level) });
};
export const setAdminActiveHandler =
  (active: boolean): RequestHandler =>
  async (req, res) => {
    res.json({ data: await setAdminActive(getAdminId(req), req.params.id, active) });
  };
export const resetAdminPasswordHandler: RequestHandler = async (req, res) => {
  res.json({ data: await resetAdminPassword(getAdminId(req), req.params.id) });
};
