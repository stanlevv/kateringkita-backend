import { RequestHandler, Router } from "express";
import { reasonBody } from "../dto/admin.dto";
import {
  aksiPenjualHandler, ambilBiayaHandler, antrianVerifikasiHandler, buatMasterHandler, buatPromoHandler, daftarLogHandler,
  daftarMasterHandler, daftarPenjualHandler, daftarPromoHandler, detailPenjualHandler, idParam, ringkasanHandler,
  setAktifMasterHandler, setAktifPromoHandler, ubahBiayaHandler, ubahMasterHandler, ubahPromoHandler,
  daftarMenuAdminHandler, daftarUlasanAdminHandler, moderasiMenuHandler, moderasiUlasanHandler,
} from "../handlers/admin.handler";
import { validate } from "../middleware/validate";
import { ACTION_NAMES } from "../services/admin-merchant.service";
import { AppError } from "../utils/errors";

// Penjaga (requireAuth + requireRole("admin")) dipasang sekali di app.ts.
export const admin = Router();

// POST <path>/activate dan <path>/deactivate
const toggle = (path: string, handler: (aktif: boolean) => RequestHandler) => {
  for (const [aksi, aktif] of [["activate", true], ["deactivate", false]] as const) {
    admin.post(`${path}/${aksi}`, handler(aktif));
  }
};

admin.get("/audit-logs", daftarLogHandler);

admin.get("/merchants", daftarPenjualHandler);

admin.get("/verification-queue", antrianVerifikasiHandler);

admin.get("/merchants/:id", detailPenjualHandler);

// id dicek sebelum body: id tak valid → 404 walau body kosong
const cekId: RequestHandler = (req, _res, next) => {
  idParam(req.params.id);
  next();
};
for (const name of ACTION_NAMES) {
  const needsReason = name === "request-fix" || name === "suspend";
  admin.post(`/merchants/:id/${name}`, cekId, ...(needsReason ? [validate(reasonBody)] : []), aksiPenjualHandler(name));
}

admin.get("/master/:kind", daftarMasterHandler);
admin.post("/master/:kind", buatMasterHandler);
admin.patch("/master/:kind/:id", ubahMasterHandler);
toggle("/master/:kind/:id", setAktifMasterHandler);

admin.get("/promos", daftarPromoHandler);
admin.post("/promos", buatPromoHandler);
admin.patch("/promos/:id", ubahPromoHandler);
toggle("/promos/:id", setAktifPromoHandler);
admin.get("/settings", ambilBiayaHandler);
admin.put("/settings/service-fee", ubahBiayaHandler);
admin.get("/summary", ringkasanHandler);

// F19 moderasi ulasan admin.get("/summary", ringkasanHandler); menu (suspend toko: /merchants/:id/suspend)
admin.get("/reviews", daftarUlasanAdminHandler);
admin.post("/reviews/:id/hide", validate(reasonBody), moderasiUlasanHandler(true));
admin.post("/reviews/:id/unhide", moderasiUlasanHandler(false));
admin.get("/menus", daftarMenuAdminHandler);
admin.post("/menus/:id/takedown", validate(reasonBody), moderasiMenuHandler(true));
admin.post("/menus/:id/restore", moderasiMenuHandler(false));

// path admin tak dikenal berhenti di sini (404), tidak jatuh ke router v1
admin.use(() => {
  throw new AppError(404, "NOT_FOUND", "Data tidak ditemukan.");
});
