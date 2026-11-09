import { NextFunction, Request, Response } from "express";
import { AppError } from "../utils/errors";

export const notFoundHandler = (_req: Request, _res: Response, next: NextFunction): void => {
  next(new AppError(404, "NOT_FOUND", "Data tidak ditemukan."));
};

export const errorHandler = (err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
  const rid = res.getHeader("X-Request-Id");
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, fields: err.fields } });
    return;
  }
  if ((err as { code?: string } | null)?.code === "ER_DUP_ENTRY") {
    res.status(409).json({ error: { code: "CONFLICT", message: "Data sudah terdaftar." } });
    return;
  }
  // error body-parser (JSON rusak, body terlalu besar, charset salah) membawa `type` + status 4xx
  const { type, status } = (err ?? {}) as { type?: string; status?: number };
  if (type && status && status >= 400 && status < 500) {
    const message = type === "entity.parse.failed" ? "Format JSON tidak valid." : "Permintaan tidak valid.";
    res.status(status).json({ error: { code: "VALIDATION_ERROR", message } });
    return;
  }
  // galat mysql2 membawa `sql` berisi data pembeli: catat kode + pesan saja
  const db = err as { sql?: unknown; code?: string; message?: string };
  if (db?.sql !== undefined) console.error(`[${rid}] Galat DB ${db.code}: ${db.message}`);
  else console.error(`[${rid}]`, err);
  res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Terjadi kesalahan pada server." } });
};
