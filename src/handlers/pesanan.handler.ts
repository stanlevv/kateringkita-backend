import { Request, RequestHandler } from "express";
import { alasanSchema, bayarOnlineSchema, bodyObjek, daftarSayaSchema, kunciSchema, pesananSchema } from "../dto/pesanan.dto";
import { kirimUlasan } from "../services/ulasan.service";
import { AuthedRequest } from "../middleware/auth";
import { parse } from "../middleware/validate";
import { bacaPesanan, batalkan, buatPesanan, daftarPesananSaya, pesanLagi, quote, selesaikan, waPesanan } from "../services/pesanan.service";
import { bayarOnline, buatVa, terimaNotifikasiMidtrans } from "../services/pembayaran-va.service";

const uid = (req: Request) => (req as AuthedRequest).auth.userId;

// F10: body sudah divalidasi vaSchema di rute
export const buatVaHandler: RequestHandler = async (req, res) => {
  res.json({ data: await buatVa(uid(req), String(req.params.code), req.body.bank) });
};

// F26: body opsional (kosong = {})
export const bayarOnlineHandler: RequestHandler = async (req, res) => {
  const { kembali } = parse(bayarOnlineSchema, bodyObjek(req.body));
  res.json({ data: await bayarOnline(uid(req), String(req.params.code), kembali) });
};

// F10: Midtrans mengulang notifikasi sampai dijawab 2xx
export const notifikasiMidtransHandler: RequestHandler = async (req, res) => {
  await terimaNotifikasiMidtrans(bodyObjek(req.body) as Record<string, unknown>);
  res.json({ data: { ok: true } });
};

export const quoteHandler: RequestHandler = async (req, res) => {
  res.json({ data: await quote(uid(req), req.body) });
};

export const buatPesananHandler: RequestHandler = async (req, res) => {
  const data = parse(pesananSchema, req.body);
  const kunci = parse(kunciSchema, req.get("Idempotency-Key"), "idempotency_key");
  res.status(201).json({ data: await buatPesanan(uid(req), kunci, data) });
};

export const bacaPesananHandler: RequestHandler = async (req, res) => {
  res.json({ data: await bacaPesanan(uid(req), String(req.params.code)) });
};

export const waPesananHandler: RequestHandler = async (req, res) => {
  res.json({ data: await waPesanan(uid(req), String(req.params.code)) });
};

export const daftarPesananSayaHandler: RequestHandler = async (req, res) => {
  res.json(await daftarPesananSaya(uid(req), parse(daftarSayaSchema, req.query)));
};

export const batalkanHandler: RequestHandler = async (req, res) => {
  const { reason } = parse(alasanSchema, bodyObjek(req.body));
  res.json({ data: await batalkan(uid(req), String(req.params.code), reason) });
};

export const selesaikanHandler: RequestHandler = async (req, res) => {
  res.json({ data: await selesaikan(uid(req), String(req.params.code)) });
};

// F13: ulasan pesanan selesai (body sudah divalidasi ulasanSchema di rute)
export const kirimUlasanHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await kirimUlasan(uid(req), String(req.params.code), req.body) });
};

// F14: pesan lagi dari pesanan lama
export const pesanLagiHandler: RequestHandler = async (req, res) => {
  res.json({ data: await pesanLagi(uid(req), String(req.params.code)) });
};
