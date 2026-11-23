// Isi file: dua middleware penutup yang dipasang paling akhir di app.ts. notFoundHandler menjawab path yang tidak cocok
// dengan route mana pun; errorHandler menangkap semua galat yang dilempar di middleware, routes, handlers, atau services
// lalu mengubahnya menjadi respons JSON `{ error: { code, message, fields } }`.
import { NextFunction, Request, Response } from "express";
import { AppError } from "../utils/errors";

/**
 * Middleware untuk request yang tidak cocok dengan route mana pun: diteruskan ke errorHandler sebagai 404.
 * @param next fungsi lanjut Express
 */
export const notFoundHandler = (_req: Request, _res: Response, next: NextFunction): void => {
  next(new AppError(404, "NOT_FOUND", "Data tidak ditemukan."));
};

/**
 * Mengubah galat menjadi respons JSON. Pesan galat tak terduga tidak dikirim ke pengguna (hanya ke log), dan
 * ringkasannya disimpan di `res.locals.errorSummary` supaya request-logger bisa mencatatnya ke tabel server_logs.
 * @param error galat yang dilempar
 * @param res   respons Express
 */
export const errorHandler = (error: unknown, _req: Request, res: Response, _next: NextFunction): void => {
  const requestId = res.getHeader("X-Request-Id");
  // 1. Galat aplikasi (AppError): kirim apa adanya. Galat 5xx (contoh 502/503 dari Midtrans atau AI) ikut dicatat.
  if (error instanceof AppError) {
    if (error.status >= 500) res.locals.errorSummary = `${error.code}: ${error.message}`;
    res.status(error.status).json({ error: { code: error.code, message: error.message, fields: error.fields } });
    return;
  }
  // 2. Data kembar di kolom unik database (contoh nomor HP sudah terdaftar) → 409.
  if ((error as { code?: string } | null)?.code === "ER_DUP_ENTRY") {
    res.status(409).json({ error: { code: "CONFLICT", message: "Data sudah terdaftar." } });
    return;
  }
  // 3. Galat permintaan dari Express, bukan galat server: body JSON rusak, terlalu besar, atau charset salah (membawa
  //    `type` dan status 4xx), juga path dengan kode persen rusak (contoh /tables/%ZZ, status 400 tanpa `type`).
  const { type, status } = (error ?? {}) as { type?: string; status?: number };
  if (status && status >= 400 && status < 500) {
    const message = type === "entity.parse.failed" ? "Format JSON tidak valid." : "Permintaan tidak valid.";
    res.status(status).json({ error: { code: "VALIDATION_ERROR", message } });
    return;
  }
  // 4. Galat tak terduga → 500. Galat mysql2 membawa `sql` yang bisa berisi data pembeli, jadi yang dicatat hanya kode
  //    dan pesannya; ringkasan untuk server_logs juga tanpa SQL dan parameternya.
  const dbError = error as { sql?: unknown; code?: string; message?: string };
  if (dbError?.sql !== undefined) console.error(`[${requestId}] Galat DB ${dbError.code}: ${dbError.message}`);
  else console.error(`[${requestId}]`, error);
  res.locals.errorSummary =
    dbError?.sql !== undefined ? `Galat DB ${dbError.code}` : String((error as Error)?.message ?? error).slice(0, 500);
  res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Terjadi kesalahan pada server." } });
};
