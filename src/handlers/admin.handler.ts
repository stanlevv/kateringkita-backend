import { RequestHandler } from "express";
import { AuthedRequest } from "../middleware/auth";
import { daftarLog, filterLog } from "../services/admin-audit.service";
import { buatMaster, daftarMaster, setAktif, ubahMaster } from "../services/admin-master.service";
import { antrianVerifikasi, daftarPenjual, detailPenjual, jalankanAksi } from "../services/admin-merchant.service";
import { ambilBiaya, ambilKontakCs, buatPromo, daftarPromo, setAktifPromo, ubahBiaya, ubahKontakCs, ubahPromo } from "../services/admin-promo.service";
import { kirimPengumuman } from "../services/admin-pengumuman.service";
import { ringkasan } from "../services/admin-summary.service";
import { rekapKeuangan } from "../services/admin-keuangan.service";
import { rentangAdminSchema } from "../dto/merchant-laporan.dto";
import { parse } from "../middleware/validate";
import { daftarMenuAdmin, daftarUlasanAdmin, moderasiMenu, moderasiUlasan } from "../services/admin-moderasi.service";
import { buatAdmin, daftarAdmin, resetSandiAdmin, setAktifAdmin, ubahLevel } from "../services/admin-akun.service";
import { AppError } from "../utils/errors";

const angka = (v: unknown, def: number, max: number) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : def;
};
export const idParam = (v: unknown) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new AppError(404, "NOT_FOUND", "Penjual tidak ditemukan.");
  return n;
};
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const adminId = (req: unknown) => (req as AuthedRequest).auth.userId;

export const daftarLogHandler: RequestHandler = async (req, res) => {
  res.json(await daftarLog(filterLog(req.query, angka(req.query.page, 1, 1e6), angka(req.query.limit, 20, 100))));
};

export const daftarPenjualHandler: RequestHandler = async (req, res) => {
  const { q, status, open } = req.query;
  res.json(await daftarPenjual({
    q: str(q)?.trim(), status: str(status), open: str(open),
    page: angka(req.query.page, 1, 1e6), limit: angka(req.query.limit, 20, 100),
  }));
};

export const antrianVerifikasiHandler: RequestHandler = async (_req, res) => {
  res.json({ data: await antrianVerifikasi() });
};

export const detailPenjualHandler: RequestHandler = async (req, res) => {
  res.json({ data: await detailPenjual(idParam(req.params.id)) });
};

// POST /merchants/:id/<name>, satu route per ACTION_NAMES
export const aksiPenjualHandler = (name: string): RequestHandler => async (req, res) => {
  res.json({ data: await jalankanAksi(adminId(req), idParam(req.params.id), name, req.body?.reason) });
};

// Tipe params sama dengan yang diturunkan Express dari path "/master/:kind" dan "/master/:kind/:id"
export const daftarMasterHandler: RequestHandler<{ kind: string }> = async (req, res) => {
  res.json({ data: await daftarMaster(req.params.kind) });
};
export const buatMasterHandler: RequestHandler<{ kind: string }> = async (req, res) => {
  res.status(201).json({ data: await buatMaster(adminId(req), req.params.kind, req.body) });
};
export const ubahMasterHandler: RequestHandler<{ kind: string; id: string }> = async (req, res) => {
  res.json({ data: await ubahMaster(adminId(req), req.params.kind, req.params.id, req.body) });
};
// POST .../activate (aktif = true) dan .../deactivate (aktif = false)
export const setAktifMasterHandler = (aktif: boolean): RequestHandler => async (req, res) => {
  res.json({ data: await setAktif(adminId(req), String(req.params.kind), req.params.id, aktif) });
};

export const daftarPromoHandler: RequestHandler = async (_req, res) => {
  res.json({ data: await daftarPromo() });
};
export const buatPromoHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await buatPromo(adminId(req), req.body) });
};
export const ubahPromoHandler: RequestHandler = async (req, res) => {
  res.json({ data: await ubahPromo(adminId(req), req.params.id, req.body) });
};
// POST .../activate (aktif = true) dan .../deactivate (aktif = false)
export const setAktifPromoHandler = (aktif: boolean): RequestHandler => async (req, res) => {
  res.json({ data: await setAktifPromo(adminId(req), req.params.id, aktif) });
};
export const ambilBiayaHandler: RequestHandler = async (_req, res) => {
  res.json({ data: { service_fee: await ambilBiaya(), cs_whatsapp: await ambilKontakCs() } });
};
export const ubahBiayaHandler: RequestHandler = async (req, res) => {
  res.json({ data: await ubahBiaya(adminId(req), req.body) });
};
export const ringkasanHandler: RequestHandler = async (_req, res) => {
  res.json({ data: await ringkasan() });
};

// F19 moderasi: ?q=&status=active|moderated&page&limit; alasan wajib untuk hide/takedown (reasonBody di rute)
const filterModerasi = (q: Record<string, unknown>) => ({
  q: str(q.q)?.trim() || undefined, status: str(q.status), page: angka(q.page, 1, 1e6), limit: angka(q.limit, 20, 100),
});
export const daftarUlasanAdminHandler: RequestHandler = async (req, res) => {
  res.json(await daftarUlasanAdmin(filterModerasi(req.query)));
};
export const moderasiUlasanHandler = (sembunyi: boolean): RequestHandler => async (req, res) => {
  res.json({ data: await moderasiUlasan(adminId(req), req.params.id, sembunyi, sembunyi ? req.body.reason : null) });
};
export const daftarMenuAdminHandler: RequestHandler = async (req, res) => {
  res.json(await daftarMenuAdmin(filterModerasi(req.query)));
};
export const moderasiMenuHandler = (turun: boolean): RequestHandler => async (req, res) => {
  res.json({ data: await moderasiMenu(adminId(req), req.params.id, turun, turun ? req.body.reason : null) });
};

// F20 rekap keuangan ?from&to (tanggal WIB, maks 92 hari)
export const rekapKeuanganHandler: RequestHandler = async (req, res) => {
  res.json({ data: await rekapKeuangan(parse(rentangAdminSchema, req.query)) });
};

// Kontak CS (body divalidasi kontakCsSchema) dan broadcast pengumuman (pengumumanSchema)
export const ubahKontakCsHandler: RequestHandler = async (req, res) => {
  res.json({ data: await ubahKontakCs(adminId(req), req.body.wa_number) });
};
export const kirimPengumumanHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await kirimPengumuman(adminId(req), req.body) });
};

// Fase 1 kelola admin (khusus super, dijaga aksesAdmin)
export const daftarAdminHandler: RequestHandler = async (_req, res) => {
  res.json({ data: await daftarAdmin() });
};
export const buatAdminHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await buatAdmin(adminId(req), req.body) });
};
export const ubahLevelAdminHandler: RequestHandler = async (req, res) => {
  res.json({ data: await ubahLevel(adminId(req), req.params.id, req.body.admin_level) });
};
export const setAktifAdminHandler = (aktif: boolean): RequestHandler => async (req, res) => {
  res.json({ data: await setAktifAdmin(adminId(req), req.params.id, aktif) });
};
export const resetSandiAdminHandler: RequestHandler = async (req, res) => {
  res.json({ data: await resetSandiAdmin(adminId(req), req.params.id) });
};
