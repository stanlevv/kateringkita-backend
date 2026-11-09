import { randomUUID } from 'node:crypto';
import { RequestHandler } from 'express';
import { catatLog, LAMBAT_MS } from '../services/log-server.service';
import { AuthedRequest } from './auth';

// ID per request: pakai X-Request-Id dari pemanggil (web/Heroku router) bila formatnya aman, selain itu buat baru
const ID_AMAN = /^[\w.:-]{1,128}$/;
export const requestId: RequestHandler = (req, res, next) => {
  const masuk = req.get('x-request-id');
  res.setHeader('X-Request-Id', masuk && ID_AMAN.test(masuk) ? masuk : randomUUID());
  next();
};

// log satu baris per request; path penuh tanpa query/body/header agar token & data pribadi tidak tercatat
export const requestLogger: RequestHandler = (req, res, next) => {
  const start = Date.now();
  res.on('finish', () => console.log(`${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode} ${Date.now() - start}ms [${res.getHeader('X-Request-Id')}]`));
  next();
};

// F23: error 5xx & request lambat ke tabel server_logs (dashboard admin). Pesan galat dari errorHandler (res.locals.galat).
// Fire-and-forget: kegagalan mencatat tidak boleh mengganggu respons.
export const catatLogServer: RequestHandler = (req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    if (res.statusCode < 500 && ms <= LAMBAT_MS) return;
    catatLog({
      requestId: String(res.getHeader('X-Request-Id') ?? '') || null,
      level: res.statusCode >= 500 ? 'error' : 'slow',
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      durationMs: ms,
      message: typeof res.locals.galat === 'string' ? res.locals.galat : null,
      userId: (req as Partial<AuthedRequest>).auth?.userId ?? null,
    }).catch(() => {});
  });
  next();
};
