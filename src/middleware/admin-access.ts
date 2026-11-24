// Isi file: pembatas akses panel admin menurut tingkat admin (super, ops, support). Middleware ini dijalankan untuk
// setiap request ke /api/v1/admin, sesudah requireAuth dan requireRole("admin") dan sebelum routes admin:
// request masuk → middleware (… → adminAccess) → routes/admin.ts → handlers → services → database.
import { RequestHandler } from "express";
import { AuthedRequest } from "./auth";
import { AppError } from "../utils/errors";

// Path (relatif ke /api/v1/admin) yang hanya untuk admin super: akun admin, AI, uang (pencairan dan refund), server.
// Mengubah /settings juga khusus super.
const SUPER_ONLY_PATHS = /^\/(admins|ai-|finance|payouts|refunds|server-)/;

// Tiket bantuan (CS) = pekerjaan admin support: semua tingkat boleh GET dan POST (balas, tutup).
const TICKET_PATHS = /^\/tickets(\/|$)/;

/**
 * Menentukan apakah admin dengan tingkat tertentu boleh menjalankan request ini.
 * Aturannya: super boleh semua; ops boleh semua kecuali path khusus super; support hanya boleh GET di luar path khusus
 * super, ditambah POST ke /tickets…. Rute Express tidak peka huruf besar/kecil (/Admins = /admins), jadi path dicek
 * dalam huruf kecil.
 * @param level   tingkat admin (`"super"`, `"ops"`, `"support"`), atau `null` bila belum diatur
 * @param method  method HTTP, contoh `"GET"`, `"POST"`
 * @param rawPath path relatif ke /api/v1/admin, contoh `/payouts/3`
 * @returns `true` bila boleh, `false` bila tidak
 */
export const canAccess = (level: string | null, method: string, rawPath: string) => {
  const path = rawPath.toLowerCase();
  const superOnly = SUPER_ONLY_PATHS.test(path) || (method !== "GET" && path.startsWith("/settings"));
  if (level === "super") return true;
  if (superOnly) return false;
  if (level === "support" && method === "POST" && TICKET_PATHS.test(path)) return true;
  return level === "ops" || (level === "support" && method === "GET");
};

/**
 * Middleware penjaga panel admin. Admin yang masih memakai sandi sementara harus menggantinya dulu (lewat
 * PUT /api/v1/me/password, yang berada di luar router admin sehingga tetap bisa dipanggil).
 * @param req  request masuk
 * @param res  respons yang akan dikirim
 * @param next fungsi Express untuk lanjut ke middleware atau route berikutnya
 * @returns tidak ada; memanggil `next()` bila admin boleh mengakses
 * @throws 403 PASSWORD_CHANGE_REQUIRED bila sandi sementara belum diganti, 403 FORBIDDEN bila tingkat admin tidak cukup
 */
export const adminAccess: RequestHandler = (req, _res, next) => {
  const { adminLevel, mustChangePassword } = (req as AuthedRequest).auth;
  if (mustChangePassword)
    throw new AppError(403, "PASSWORD_CHANGE_REQUIRED", "Ganti kata sandi sementara terlebih dahulu.");
  if (!canAccess(adminLevel, req.method, req.path))
    throw new AppError(403, "FORBIDDEN", "Tingkat admin Anda tidak memiliki akses ke fitur ini.");
  next();
};
