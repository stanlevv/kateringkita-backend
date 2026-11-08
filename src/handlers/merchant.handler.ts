import { RequestHandler } from "express";
import { kuotaSchema, menuQuerySchema } from "../dto/merchant-menu.dto";
import { daftarTokoSchema } from "../dto/merchant-order.dto";
import { rentangSchema, tanggalSchema } from "../dto/merchant-laporan.dto";
import { AuthedRequest } from "../middleware/auth";
import { fieldsDari, parse } from "../middleware/validate";
import { ambilMenu, buatMenu, daftarMenu, hapusMenu, idToko, ubahKuota, ubahMenu } from "../services/merchant-menu.service";
import { AKSI_TOKO, AksiToko, aksiPesananToko, ambilPesananToko, daftarPesananToko, waPesananToko } from "../services/merchant-order.service";
import { getProfile, setOpen, updateProfile } from "../services/merchant.service";
import { laporanPerJam, laporanTransaksi, ringkasanLaporan } from "../services/merchant-laporan.service";
import { buatPromoToko, daftarPromoToko, hapusPromoToko, ubahPromoToko } from "../services/merchant-promo.service";
import { daftarUlasanToko } from "../services/ulasan.service";
import { tanyaAsisten } from "../services/asisten.service";
import { buatUnggahan } from "../services/upload.service";
import { AppError } from "../utils/errors";

// Toko selalu dari token (R-10).
const uid = (req: unknown) => (req as AuthedRequest).auth.userId;

export const getProfileHandler: RequestHandler = async (req, res) => {
  res.json({ data: await getProfile(uid(req)) });
};

export const setOpenHandler: RequestHandler = async (req, res) => {
  res.json({ data: await setOpen(uid(req), req.body.is_open) });
};

export const updateProfileHandler: RequestHandler = async (req, res) => {
  res.json({ data: await updateProfile(uid(req), req.body) });
};

export const daftarMenuHandler: RequestHandler = async (req, res) => {
  res.json({ data: await daftarMenu(uid(req), parse(menuQuerySchema, req.query)) });
};

export const ambilMenuHandler: RequestHandler = async (req, res) => {
  res.json({ data: await ambilMenu(uid(req), req.params.id) });
};

export const buatMenuHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await buatMenu(uid(req), req.body) });
};

export const ubahMenuHandler: RequestHandler = async (req, res) => {
  res.json({ data: await ubahMenu(uid(req), req.params.id, req.body) });
};

export const hapusMenuHandler: RequestHandler = async (req, res) => {
  await hapusMenu(uid(req), req.params.id);
  res.status(204).end();
};

export const ubahKuotaHandler: RequestHandler = async (req, res) => {
  const r = kuotaSchema.safeParse(req.body);
  if (!r.success) {
    // galat lintas-field (path kosong) tidak punya field; galat per field tetap di fields
    const fields = fieldsDari(r.error.issues.filter((i) => i.path.length > 0));
    throw new AppError(400, "VALIDATION_ERROR", "Data kuota tidak valid.", Object.keys(fields).length ? fields : undefined);
  }
  res.json({ data: await ubahKuota(uid(req), req.params.id, r.data) });
};

export const uploadFotoHandler: RequestHandler = async (req, res) => {
  const { purpose, ...file } = req.body;
  res.json({ data: buatUnggahan(`merchants/${await idToko(uid(req))}/${purpose}/`, file) });
};

export const daftarPesananTokoHandler: RequestHandler = async (req, res) => {
  res.json(await daftarPesananToko(uid(req), parse(daftarTokoSchema, req.query)));
};

export const ambilPesananTokoHandler: RequestHandler = async (req, res) => {
  res.json({ data: await ambilPesananToko(uid(req), String(req.params.code)) });
};

export const waPesananTokoHandler: RequestHandler = async (req, res) => {
  res.json({ data: await waPesananToko(uid(req), String(req.params.code)) });
};

// aksi di luar AKSI_TOKO → lanjut ke notFoundHandler (404)
export const aksiPesananTokoHandler: RequestHandler = async (req, res, next) => {
  const aksi = String(req.params.aksi) as AksiToko;
  if (!AKSI_TOKO.includes(aksi)) return next();
  res.json({ data: await aksiPesananToko(uid(req), String(req.params.code), aksi, req.body) });
};

// F09 laporan (LP-N1..N4)
export const ringkasanLaporanHandler: RequestHandler = async (req, res) => {
  res.json({ data: await ringkasanLaporan(uid(req), parse(rentangSchema, req.query)) });
};

export const laporanPerJamHandler: RequestHandler = async (req, res) => {
  res.json({ data: await laporanPerJam(uid(req), parse(tanggalSchema, req.query).date) });
};

export const laporanTransaksiHandler: RequestHandler = async (req, res) => {
  res.json({ data: await laporanTransaksi(uid(req), parse(rentangSchema, req.query)) });
};

// F12 promo toko
export const daftarPromoTokoHandler: RequestHandler = async (req, res) => {
  res.json({ data: await daftarPromoToko(uid(req)) });
};

export const buatPromoTokoHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await buatPromoToko(uid(req), req.body) });
};

export const ubahPromoTokoHandler: RequestHandler = async (req, res) => {
  res.json({ data: await ubahPromoToko(uid(req), req.params.id, req.body) });
};

// {data:{id}} (bukan 204) agar fe hasil() menerima sukses
export const hapusPromoTokoHandler: RequestHandler = async (req, res) => {
  res.json({ data: await hapusPromoToko(uid(req), req.params.id) });
};

// F13 ulasan toko
export const daftarUlasanTokoHandler: RequestHandler = async (req, res) => {
  res.json({ data: await daftarUlasanToko(uid(req)) });
};

// F17 asisten AI toko (body divalidasi tanyaSchema di rute)
export const tanyaAsistenHandler: RequestHandler = async (req, res) => {
  res.json({ data: await tanyaAsisten(uid(req), req.body.question) });
};
