import { NextFunction, Request, Response } from "express";
import { AppError } from "../utils/errors";

export const notFoundHandler = (_req: Request, _res: Response, next: NextFunction): void => {
  next(new AppError(404, "NOT_FOUND", "Data tidak ditemukan."));
};

export const errorHandler = (error: unknown, _req: Request, res: Response, _next: NextFunction): void => {
  const requestId = res.getHeader("X-Request-Id");
  if (error instanceof AppError) {
    if (error.status >= 500) res.locals.errorSummary = `${error.code}: ${error.message}`; // F23: 502/503 penyedia luar ikut tercatat
    res.status(error.status).json({ error: { code: error.code, message: error.message, fields: error.fields } });
    return;
  }
  if ((error as { code?: string } | null)?.code === "ER_DUP_ENTRY") {
    res.status(409).json({ error: { code: "CONFLICT", message: "Data sudah terdaftar." } });
    return;
  }
  // error body-parser (JSON rusak, body terlalu besar, charset salah) membawa `type` + status 4xx; URIError dari path
  // dengan persen rusak (mis. /tables/%ZZ) membawa status 400 tanpa `type` (AUD-44): galat permintaan, bukan galat server
  const { type, status } = (error ?? {}) as { type?: string; status?: number };
  if (status && status >= 400 && status < 500) {
    const message = type === "entity.parse.failed" ? "Format JSON tidak valid." : "Permintaan tidak valid.";
    res.status(status).json({ error: { code: "VALIDATION_ERROR", message } });
    return;
  }
  // galat mysql2 membawa `sql` berisi data pembeli: catat kode + pesan saja
  const dbError = error as { sql?: unknown; code?: string; message?: string };
  if (dbError?.sql !== undefined) console.error(`[${requestId}] Galat DB ${dbError.code}: ${dbError.message}`);
  else console.error(`[${requestId}]`, error);
  // F23: ringkasan galat untuk server_logs (tanpa SQL/parameter yang bisa memuat data pembeli)
  res.locals.errorSummary =
    dbError?.sql !== undefined ? `Galat DB ${dbError.code}` : String((error as Error)?.message ?? error).slice(0, 500);
  res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Terjadi kesalahan pada server." } });
};
