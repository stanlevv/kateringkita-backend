import { Request, RequestHandler } from "express";
import { AuthedRequest } from "../middleware/auth";
import { bayarMeja, buatMeja, daftarMeja, menuMeja, pesanMeja, statusMeja, ubahMeja } from "../services/meja.service";

// F21 pesan dari meja. Body sudah divalidasi skema di rute.
const uid = (req: Request) => (req as AuthedRequest).auth.userId;
// token tamu dikirim lewat header agar tidak tercatat di log URL
const tamu = (req: Request) => req.get("x-guest-token") ?? "";

export const daftarMejaHandler: RequestHandler = async (req, res) => {
  res.json({ data: await daftarMeja(uid(req)) });
};

export const buatMejaHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await buatMeja(uid(req), req.body.label) });
};

export const ubahMejaHandler: RequestHandler = async (req, res) => {
  res.json({ data: await ubahMeja(uid(req), req.params.id, req.body) });
};

export const menuMejaHandler: RequestHandler = async (req, res) => {
  res.json({ data: await menuMeja(String(req.params.token)) });
};

export const pesanMejaHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await pesanMeja(String(req.params.token), req.body) });
};

export const statusMejaHandler: RequestHandler = async (req, res) => {
  res.json({ data: await statusMeja(String(req.params.code), tamu(req)) });
};

export const bayarMejaHandler: RequestHandler = async (req, res) => {
  res.json({ data: await bayarMeja(String(req.params.code), tamu(req), req.body.kembali) });
};
