import { Router } from "express";
import { daftarNotifikasiHandler, tandaiDibacaHandler } from "../handlers/notifikasi.handler";
import { requireAuth } from "../middleware/auth";

// F08 (C-21, R-10): notifikasi in-app milik pengguna yang login (semua peran; penjual/admin hanya mendapat daftar kosong, D13)
export const notifikasi = Router();

notifikasi.get("/me/notifications", requireAuth, daftarNotifikasiHandler);

notifikasi.post("/me/notifications/read", requireAuth, tandaiDibacaHandler);
