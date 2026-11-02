import express, { Application } from 'express';
import cors from 'cors';
import { v1 } from './auth/routes';
import { requireAuth, requireRole } from './auth/middleware';
import { meta } from './meta/routes';
import { admin } from './admin/routes';
import { merchant } from './merchant/routes';
import { katalog } from './katalog/routes';
import { pesanan } from './pesanan/routes';
import { notifikasi } from './notifikasi/routes';
import { errorHandler, notFoundHandler } from './http/errorHandler';
import { env } from './config/env';
import db from './config/db';
import { AppError } from './http/errors';

const app: Application = express();

// production wajib mengisi CORS_ORIGIN (divalidasi di env.ts); dev default ke web lokal
app.use(cors({ origin: env.CORS_ORIGIN.length ? env.CORS_ORIGIN : ['http://localhost:3000'] }));
app.use(express.json());

// log satu baris per request; path penuh tanpa query/body/header agar token & data pribadi tidak tercatat
if (env.NODE_ENV !== 'test') {
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => console.log(`${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode} ${Date.now() - start}ms`));
    next();
  });
}

app.get('/api/v1/health', async (_req, res) => {
  try {
    await db.query('SELECT 1');
  } catch (err) {
    console.error(err);
    throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Database tidak dapat dihubungi.');
  }
  res.json({ data: { status: 'ok', db: 'ok' } });
});

// admin dipasang sebelum v1; path admin tak dikenal: tanpa token 401, bukan admin 403, admin 404 (notFound)
app.use('/api/v1/admin', requireAuth, requireRole('admin'), admin);
app.use('/api/v1/merchant', requireAuth, requireRole('merchant'), merchant);
app.use('/api/v1', katalog);
app.use('/api/v1', pesanan);
app.use('/api/v1', notifikasi);
app.use('/api/v1', v1);
app.use('/api/v1', meta);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
