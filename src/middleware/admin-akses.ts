import { RequestHandler } from "express";
import { AuthedRequest } from "./auth";
import { AppError } from "../utils/errors";

// Path (relatif ke /api/v1/admin) yang hanya untuk admin super: akun admin, AI, uang (F26 payouts/refunds), server.
// Penulisan /settings juga khusus super.
const KHUSUS_SUPER = /^\/(admins|ai-|finance|payouts|refunds|server-)/;

// Tiket bantuan (CS) = pekerjaan admin support: semua tingkat boleh GET dan POST (balas, tutup).
const TIKET = /^\/tickets(\/|$)/;

// super = semua; ops = semua kecuali KHUSUS_SUPER; support = hanya GET di luar KHUSUS_SUPER, plus POST /tickets….
// Rute Express tidak peka huruf besar/kecil (/Admins = /admins), jadi path dicek dalam huruf kecil.
export const bolehAkses = (level: string | null, method: string, rawPath: string) => {
  const path = rawPath.toLowerCase();
  const superSaja = KHUSUS_SUPER.test(path) || (method !== "GET" && path.startsWith("/settings"));
  if (level === "super") return true;
  if (superSaja) return false;
  if (level === "support" && method === "POST" && TIKET.test(path)) return true;
  return level === "ops" || (level === "support" && method === "GET");
};

// Dipasang setelah requireRole("admin"). Sandi sementara harus diganti dulu (PUT /api/v1/me/password, di luar router ini).
export const aksesAdmin: RequestHandler = (req, _res, next) => {
  const { adminLevel, mustChangePassword } = (req as AuthedRequest).auth;
  if (mustChangePassword) throw new AppError(403, "PASSWORD_CHANGE_REQUIRED", "Ganti kata sandi sementara terlebih dahulu.");
  if (!bolehAkses(adminLevel, req.method, req.path)) throw new AppError(403, "FORBIDDEN", "Tingkat admin Anda tidak memiliki akses ke fitur ini.");
  next();
};
