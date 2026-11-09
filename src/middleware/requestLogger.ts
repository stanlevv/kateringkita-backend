import { randomUUID } from 'node:crypto';
import { RequestHandler } from 'express';

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
