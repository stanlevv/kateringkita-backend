import { Request, Router } from "express";
import { AuthedRequest, requireAuth } from "../auth/middleware";
import { parse } from "../http/validate";
import { bodyObjek } from "../pesanan/schemas";
import { daftarNotifSchema, tandaiSchema } from "./schemas";
import { daftarNotifikasi, tandaiDibaca } from "./service";

// F08 (C-21, R-10): notifikasi in-app milik pengguna yang login (semua peran; penjual/admin hanya mendapat daftar kosong, D13)
export const notifikasi = Router();
const uid = (req: Request) => (req as AuthedRequest).auth.userId;

notifikasi.get("/me/notifications", requireAuth, async (req, res) => {
  res.json(await daftarNotifikasi(uid(req), parse(daftarNotifSchema, req.query)));
});

notifikasi.post("/me/notifications/read", requireAuth, async (req, res) => {
  res.json({ data: await tandaiDibaca(uid(req), parse(tandaiSchema, bodyObjek(req.body))) });
});
