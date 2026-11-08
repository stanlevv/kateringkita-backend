import express, { Application } from 'express';
import cors from 'cors';
import { v1 } from './routes/auth';
import { requireAuth, requireRole } from './middleware/auth';
import { meta } from './routes/meta';
import { admin } from './routes/admin';
import { merchant } from './routes/merchant';
import { katalog } from './routes/katalog';
import { pesanan } from './routes/pesanan';
import { notifikasi } from './routes/notifikasi';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { requestLogger } from './middleware/requestLogger';
import { healthHandler } from './handlers/health.handler';
import { env } from './config/env';

const app: Application = express();

// production wajib mengisi CORS_ORIGIN (divalidasi di env.ts); dev default ke web lokal
app.use(cors({ origin: env.CORS_ORIGIN.length ? env.CORS_ORIGIN : ['http://localhost:3000'] }));
app.use(express.json());

if (env.NODE_ENV !== 'test') {
  app.use(requestLogger);
}

app.get('/api/v1/health', healthHandler);

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
