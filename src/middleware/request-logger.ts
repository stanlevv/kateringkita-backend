// Isi file: tiga middleware pencatat yang dipasang paling awal di app.ts (sebelum pemeriksaan pemeliharaan dan routes):
// requestId memberi setiap request sebuah id, recordServerLog menyimpan request bermasalah ke tabel server_logs, dan
// requestLogger menulis satu baris log per request (tidak dipasang saat test).
import { randomUUID } from "node:crypto";
import { RequestHandler } from "express";
import { catatLog, LAMBAT_MS } from "../services/log-server.service";
import { AuthedRequest } from "./auth";

// Id dari pemanggil hanya dipakai bila berisi huruf, angka, dan . : _ - (paling panjang 128), supaya log tidak bisa
// disisipi teks aneh.
const SAFE_ID_PATTERN = /^[\w.:-]{1,128}$/;

/**
 * Memberi id unik pada setiap request lewat header respons X-Request-Id. Id dari pemanggil (server web atau router
 * Heroku) dipakai ulang bila formatnya aman, supaya satu request bisa dilacak di log kedua server; selain itu dibuat
 * id acak baru.
 * @param req  request masuk
 * @param res  respons yang akan dikirim
 * @param next fungsi Express untuk lanjut ke middleware atau route berikutnya
 * @returns tidak ada; memasang header X-Request-Id lalu memanggil `next()`
 */
export const requestId: RequestHandler = (req, res, next) => {
  const incomingId = req.get("x-request-id");
  res.setHeader("X-Request-Id", incomingId && SAFE_ID_PATTERN.test(incomingId) ? incomingId : randomUUID());
  next();
};

/**
 * Menulis satu baris log setelah respons terkirim: method, path, status, lama proses, dan id request. Path ditulis
 * tanpa query, body, atau header supaya token dan data pribadi tidak ikut tercatat.
 * @param req  request masuk
 * @param res  respons yang akan dikirim
 * @param next fungsi Express untuk lanjut ke middleware atau route berikutnya
 * @returns tidak ada; memasang pencatat di akhir respons lalu memanggil `next()`
 */
export const requestLogger: RequestHandler = (req, res, next) => {
  const startedAt = Date.now();
  res.on("finish", () =>
    console.log(
      `${req.method} ${req.originalUrl.split("?")[0]} ${res.statusCode} ${Date.now() - startedAt}ms [${res.getHeader("X-Request-Id")}]`,
    ),
  );
  next();
};

/**
 * Menyimpan request yang gagal di server (status 5xx) atau lambat (lebih dari `LAMBAT_MS`) ke tabel server_logs untuk
 * dashboard admin. Pesan galatnya diambil dari `res.locals.errorSummary` yang diisi errorHandler. 503 karena mode
 * pemeliharaan dilewati karena disengaja, bukan galat server. Penyimpanan berjalan tanpa ditunggu, dan kegagalannya
 * diabaikan supaya tidak mengganggu respons.
 * @param req  request masuk
 * @param res  respons yang akan dikirim
 * @param next fungsi Express untuk lanjut ke middleware atau route berikutnya
 * @returns tidak ada; memasang pencatat di akhir respons lalu memanggil `next()`
 */
export const recordServerLog: RequestHandler = (req, res, next) => {
  const startedAt = Date.now();
  res.on("finish", () => {
    // 1. Lewati request yang berhasil dan cukup cepat, juga 503 karena mode pemeliharaan.
    const durationMs = Date.now() - startedAt;
    if (res.statusCode < 500 && durationMs <= LAMBAT_MS) return;
    if (res.locals.maintenance) return;
    // 2. Simpan tanpa ditunggu; kegagalan menyimpan diabaikan.
    catatLog({
      requestId: String(res.getHeader("X-Request-Id") ?? "") || null,
      level: res.statusCode >= 500 ? "error" : "slow",
      method: req.method,
      path: req.originalUrl.split("?")[0],
      status: res.statusCode,
      durationMs,
      message: typeof res.locals.errorSummary === "string" ? res.locals.errorSummary : null,
      userId: (req as Partial<AuthedRequest>).auth?.userId ?? null,
    }).catch(() => {});
  });
  next();
};
