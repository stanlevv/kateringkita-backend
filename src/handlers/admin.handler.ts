import { RequestHandler } from "express";
import { AuthedRequest } from "../middleware/auth";
import { daftarLog, filterLog } from "../services/admin-audit.service";
import { buatMaster, daftarMaster, setAktif, ubahMaster } from "../services/admin-master.service";
import { antrianVerifikasi, daftarPenjual, detailPenjual, jalankanAksi } from "../services/admin-merchant.service";
import { ambilBiaya, buatPromo, daftarPromo, setAktifPromo, ubahBiaya, ubahPromo } from "../services/admin-promo.service";
import { ringkasan } from "../services/admin-summary.service";
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
  res.json({ data: { service_fee: await ambilBiaya() } });
};
export const ubahBiayaHandler: RequestHandler = async (req, res) => {
  res.json({ data: await ubahBiaya(adminId(req), req.body) });
};
export const ringkasanHandler: RequestHandler = async (_req, res) => {
  res.json({ data: await ringkasan() });
};
