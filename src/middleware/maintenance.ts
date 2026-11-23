// Isi file: penjaga mode pemeliharaan. Saat admin menyalakan mode pemeliharaan, semua request dijawab 503 kecuali
// beberapa rute penting. Dijalankan untuk semua request sesudah cek kesehatan /api/v1/health dan sebelum semua routes:
// request masuk → middleware (… → maintenanceGuard) → routes → handlers → services → database.
import { RequestHandler } from "express";
import { AppError } from "../utils/errors";
import { PESAN_BAWAAN, ambilPemeliharaan } from "../services/maintenance.service";

// Rute yang tetap jalan saat pemeliharaan: login/logout/me/ganti sandi agar admin bisa masuk; meta/settings agar
// aplikasi tahu statusnya; notifikasi Midtrans agar pembayaran tetap tercatat. Semua path /admin juga tetap jalan
// (tetap dijaga requireAuth dan requireRole("admin")).
const ALLOWED_ROUTES = new Set([
  "POST /api/v1/auth/login",
  "POST /api/v1/auth/logout",
  "GET /api/v1/me",
  "PUT /api/v1/me/password",
  "GET /api/v1/meta/settings",
  "POST /api/v1/payments/midtrans",
]);

/**
 * Middleware mode pemeliharaan. Bila aktif, menandai `res.locals.maintenance` (supaya 503 ini tidak dicatat sebagai
 * galat server) dan meminta klien mencoba lagi 5 menit kemudian lewat header Retry-After.
 * @param req  request masuk
 * @param res  respons yang akan dikirim
 * @param next fungsi Express untuk lanjut ke middleware atau route berikutnya
 * @returns Promise yang selesai setelah `next()` dipanggil bila request boleh lanjut
 * @throws 503 MAINTENANCE berisi pesan pemeliharaan dari admin, atau pesan bawaan bila admin tidak mengisinya
 */
export const maintenanceGuard: RequestHandler = async (req, res, next) => {
  // 1. Rute Express tidak peka huruf besar/kecil dan mengabaikan garis miring akhir, jadi path dinormalkan dulu.
  const path = req.path.toLowerCase().replace(/\/+$/, "");
  // 2. Rute admin dan rute pengecualian selalu lewat.
  if (path === "/api/v1/admin" || path.startsWith("/api/v1/admin/") || ALLOWED_ROUTES.has(`${req.method} ${path}`))
    return next();
  // 3. Baca status pemeliharaan; bila mati, lanjut seperti biasa.
  const { aktif: active, pesan: message } = await ambilPemeliharaan();
  if (!active) return next();
  // 4. Bila menyala, tolak dengan 503.
  res.set("Retry-After", "300");
  res.locals.maintenance = true;
  throw new AppError(503, "MAINTENANCE", message ?? PESAN_BAWAAN);
};
