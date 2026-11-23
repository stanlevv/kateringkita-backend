import { randomUUID } from "node:crypto";
import { RequestHandler } from "express";
import { catatLog, LAMBAT_MS } from "../services/log-server.service";
import { AuthedRequest } from "./auth";

// ID per request: pakai X-Request-Id dari pemanggil (web/Heroku router) bila formatnya aman, selain itu buat baru
const SAFE_ID_PATTERN = /^[\w.:-]{1,128}$/;
export const requestId: RequestHandler = (req, res, next) => {
  const incomingId = req.get("x-request-id");
  res.setHeader("X-Request-Id", incomingId && SAFE_ID_PATTERN.test(incomingId) ? incomingId : randomUUID());
  next();
};

// log satu baris per request; path penuh tanpa query/body/header agar token & data pribadi tidak tercatat
export const requestLogger: RequestHandler = (req, res, next) => {
  const startedAt = Date.now();
  res.on("finish", () =>
    console.log(
      `${req.method} ${req.originalUrl.split("?")[0]} ${res.statusCode} ${Date.now() - startedAt}ms [${res.getHeader("X-Request-Id")}]`,
    ),
  );
  next();
};

// F23: error 5xx & request lambat ke tabel server_logs (dashboard admin). Pesan galat dari errorHandler (res.locals.errorSummary).
// Fire-and-forget: kegagalan mencatat tidak boleh mengganggu respons.
export const recordServerLog: RequestHandler = (req, res, next) => {
  const startedAt = Date.now();
  res.on("finish", () => {
    const durationMs = Date.now() - startedAt;
    if (res.statusCode < 500 && durationMs <= LAMBAT_MS) return;
    if (res.locals.maintenance) return; // F27: 503 pemeliharaan disengaja, bukan galat server
    catatLog({
      requestId: String(res.getHeader("X-Request-Id") ?? "") || null,
      level: res.statusCode >= 500 ? "error" : "slow",
      method: req.method,
      path: req.originalUrl.split("?")[0],
      status: res.statusCode,
      durationMs: durationMs,
      message: typeof res.locals.errorSummary === "string" ? res.locals.errorSummary : null,
      userId: (req as Partial<AuthedRequest>).auth?.userId ?? null,
    }).catch(() => {});
  });
  next();
};
