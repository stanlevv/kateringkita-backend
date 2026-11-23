import { RequestHandler } from "express";
import { AppError } from "../utils/errors";
import { PESAN_BAWAAN, ambilPemeliharaan } from "../services/pemeliharaan.service";

// F27: rute yang tetap jalan saat pemeliharaan. /admin tetap dijaga requireAuth + requireRole('admin');
// login/me/ganti sandi agar admin bisa masuk; meta/settings agar klien tahu statusnya; webhook agar pembayaran tetap tercatat.
const BOLEH = new Set([
  "POST /api/v1/auth/login",
  "POST /api/v1/auth/logout",
  "GET /api/v1/me",
  "PUT /api/v1/me/password",
  "GET /api/v1/meta/settings",
  "POST /api/v1/payments/midtrans",
]);

export const pemeliharaan: RequestHandler = async (req, res, next) => {
  // rute Express tidak peka huruf besar/kecil dan mengabaikan garis miring akhir, jadi path dinormalkan dulu
  const path = req.path.toLowerCase().replace(/\/+$/, "");
  if (path === "/api/v1/admin" || path.startsWith("/api/v1/admin/") || BOLEH.has(`${req.method} ${path}`))
    return next();
  const { aktif, pesan } = await ambilPemeliharaan();
  if (!aktif) return next();
  res.set("Retry-After", "300");
  res.locals.pemeliharaan = true;
  throw new AppError(503, "MAINTENANCE", pesan ?? PESAN_BAWAAN);
};
