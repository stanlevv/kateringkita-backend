import { RequestHandler } from 'express';

// log satu baris per request; path penuh tanpa query/body/header agar token & data pribadi tidak tercatat
export const requestLogger: RequestHandler = (req, res, next) => {
  const start = Date.now();
  res.on('finish', () => console.log(`${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode} ${Date.now() - start}ms`));
  next();
};
