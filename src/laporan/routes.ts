import { Router } from "express";
import { AuthedRequest } from "../auth/middleware";
import { parse } from "../http/validate";
import { rentangSchema, tanggalSchema } from "./schemas";
import { laporanPerJam, ringkasanLaporan, transaksiLaporan } from "./service";

export const laporan = Router();
const uid = (req: unknown) => (req as AuthedRequest).auth.userId;

// F09 (M-09): ringkasan, per jam, buku transaksi laporan
laporan.get("/summary", async (req, res) => {
  res.json({ data: await ringkasanLaporan(uid(req), parse(rentangSchema, req.query)) });
});

laporan.get("/transactions", async (req, res) => {
  res.json({ data: await transaksiLaporan(uid(req), parse(rentangSchema, req.query)) });
});

laporan.get("/hourly", async (req, res) => {
  res.json({ data: await laporanPerJam(uid(req), parse(tanggalSchema, req.query)) });
});

