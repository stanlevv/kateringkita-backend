import { Request, RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { env } from "../config/env";
import { AppError } from "../utils/errors";
import { PublicUser } from "../services/auth.service";

export type AdminLevel = "super" | "ops" | "support";
export type AuthedRequest = Request & {
  auth: { userId: number; role: PublicUser["role"]; jti: string; adminLevel: AdminLevel | null; mustChangePassword: boolean };
};

const unauthenticated = () => new AppError(401, "UNAUTHENTICATED", "Silakan masuk terlebih dahulu.");

// Sesi dari header Bearer; null bila tidak ada/tidak valid/kadaluarsa/dicabut (galat DB tetap dilempar)
export async function bacaSesi(req: Request): Promise<AuthedRequest["auth"] | null> {
  const header = req.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;

  let payload;
  try {
    payload = jwt.verify(header.slice(7), env.JWT_SECRET);
  } catch {
    return null;
  }
  if (typeof payload === "string" || !payload.jti || !payload.sub) return null;

  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT u.id, u.role, u.admin_level, u.must_change_password FROM auth_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.jti = ? AND s.revoked_at IS NULL AND s.expires_at > UTC_TIMESTAMP() AND u.is_active = TRUE`,
    [payload.jti],
  );
  if (rows.length === 0) return null;
  return {
    userId: rows[0].id, role: rows[0].role, jti: payload.jti,
    adminLevel: rows[0].admin_level ?? null, mustChangePassword: Boolean(rows[0].must_change_password),
  };
}

export const requireAuth: RequestHandler = async (req, _res, next) => {
  const auth = await bacaSesi(req);
  if (!auth) throw unauthenticated();
  (req as AuthedRequest).auth = auth;
  next();
};

// D14 (F05): katalog publik membaca sesi bila ada, tanpa pernah 401; galat DB saat membaca sesi → tamu
export const authOpsional: RequestHandler = async (req, _res, next) => {
  const auth = await bacaSesi(req).catch((err) => {
    // hanya pesan: objek galat mysql2 membawa SQL berisi jti sesi
    console.error("Gagal membaca sesi:", err instanceof Error ? err.message : err);
    return null;
  });
  if (auth) (req as AuthedRequest).auth = auth;
  next();
};

export const requireRole =
  (...roles: PublicUser["role"][]): RequestHandler =>
  (req, _res, next) => {
    if (!roles.includes((req as AuthedRequest).auth.role)) {
      throw new AppError(403, "FORBIDDEN", "Anda tidak memiliki akses.");
    }
    next();
  };
