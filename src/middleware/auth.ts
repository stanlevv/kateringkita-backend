// Isi file: middleware login (autentikasi) dan peran pengguna. Dijalankan sebelum routes yang butuh login:
// request masuk → middleware (requireAuth → requireRole) → routes → handlers → services → database.
// Pengguna login membawa JWT (JSON Web Token): teks yang ditandatangani server dengan JWT_SECRET sehingga tidak bisa
// dipalsukan, dikirim di header `Authorization: Bearer <token>`. Setiap token punya `jti` (id sesi) yang dicocokkan ke
// tabel auth_sessions, supaya sesi yang sudah logout atau dicabut admin langsung tidak berlaku.
import { Request, RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { env } from "../config/env";
import { AppError } from "../utils/errors";
import { PublicUser } from "../services/auth.service";

/** Tingkat admin: super (semua fitur), ops (operasional), support (layanan pelanggan). */
export type AdminLevel = "super" | "ops" | "support";
/** Request Express yang sudah lolos requireAuth: `req.auth` berisi data pengguna yang login. */
export type AuthedRequest = Request & {
  auth: {
    userId: number;
    role: PublicUser["role"];
    jti: string;
    adminLevel: AdminLevel | null;
    mustChangePassword: boolean;
  };
};

const unauthenticated = () => new AppError(401, "UNAUTHENTICATED", "Silakan masuk terlebih dahulu.");

/**
 * Membaca sesi login dari header `Authorization: Bearer <token>`.
 * @param req request Express
 * @returns data sesi (id pengguna, peran, id sesi, tingkat admin, wajib ganti sandi), atau `null` bila token tidak ada,
 *          tidak valid, kedaluwarsa, sesinya dicabut, atau akunnya nonaktif
 * @throws galat database diteruskan apa adanya (bukan dianggap tamu)
 */
export async function getSession(req: Request): Promise<AuthedRequest["auth"] | null> {
  // 1. Ambil token dari header; tanpa awalan "Bearer " berarti tidak login.
  const header = req.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;

  // 2. Periksa tanda tangan dan masa berlaku token; token rusak atau kedaluwarsa dianggap tidak login.
  let payload;
  try {
    payload = jwt.verify(header.slice(7), env.JWT_SECRET);
  } catch {
    return null;
  }
  if (typeof payload === "string" || !payload.jti || !payload.sub) return null;

  // 3. Pastikan sesi masih aktif di database (belum logout/dicabut, belum lewat waktu) dan akunnya masih aktif.
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT u.id, u.role, u.admin_level, u.must_change_password FROM auth_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.jti = ? AND s.revoked_at IS NULL AND s.expires_at > UTC_TIMESTAMP() AND u.is_active = TRUE`,
    [payload.jti],
  );
  if (rows.length === 0) return null;
  return {
    userId: rows[0].id,
    role: rows[0].role,
    jti: payload.jti,
    adminLevel: rows[0].admin_level ?? null,
    mustChangePassword: Boolean(rows[0].must_change_password),
  };
}

/**
 * Middleware wajib login: menaruh data sesi di `req.auth` lalu lanjut.
 * @throws 401 UNAUTHENTICATED bila tidak ada sesi yang sah
 */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  const auth = await getSession(req);
  if (!auth) throw unauthenticated();
  (req as AuthedRequest).auth = auth;
  next();
};

/**
 * Middleware login opsional untuk halaman publik (katalog): bila ada sesi sah, `req.auth` diisi; bila tidak, request
 * tetap lanjut sebagai tamu dan tidak pernah dijawab 401. Galat database saat membaca sesi juga diperlakukan sebagai
 * tamu.
 */
export const optionalAuth: RequestHandler = async (req, _res, next) => {
  const auth = await getSession(req).catch((error) => {
    // hanya pesan: objek galat mysql2 membawa SQL berisi jti sesi
    console.error("Gagal membaca sesi:", error instanceof Error ? error.message : error);
    return null;
  });
  if (auth) (req as AuthedRequest).auth = auth;
  next();
};

/**
 * Membuat middleware pembatas peran; dipasang sesudah {@link requireAuth}.
 * @param roles peran yang boleh lewat, contoh `"merchant"` atau `"admin"`
 * @returns middleware yang melempar 403 FORBIDDEN bila peran pengguna tidak termasuk `roles`
 */
export const requireRole =
  (...roles: PublicUser["role"][]): RequestHandler =>
  (req, _res, next) => {
    if (!roles.includes((req as AuthedRequest).auth.role)) {
      throw new AppError(403, "FORBIDDEN", "Anda tidak memiliki akses.");
    }
    next();
  };
