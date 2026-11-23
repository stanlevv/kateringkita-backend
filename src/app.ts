import express, { Application } from "express";
import cors from "cors";
import { v1 } from "./routes/auth";
import { requireAuth, requireRole } from "./middleware/auth";
import { meta } from "./routes/meta";
import { admin } from "./routes/admin";
import { adminAccess } from "./middleware/admin-access";
import { merchant } from "./routes/merchant";
import { katalog } from "./routes/katalog";
import { table } from "./routes/table";
import { order } from "./routes/order";
import { notifikasi } from "./routes/notifikasi";
import { tiket } from "./routes/tiket";
import { errorHandler, notFoundHandler } from "./middleware/error-handler";
import { recordServerLog, requestId, requestLogger } from "./middleware/request-logger";
import { healthHandler } from "./handlers/health.handler";
import { env } from "./config/env";
import { maintenanceGuard } from "./middleware/maintenance";

const app: Application = express();

// Heroku: tepat satu router di depan app, jadi req.ip = entri terakhir X-Forwarded-For (IP asli, tak bisa dipalsukan klien).
// Tanpa ini semua pengguna berbagi IP router dan batas per IP (OTP, login) jadi bersama. Di luar production tidak dipercaya.
if (env.NODE_ENV === "production") app.set("trust proxy", 1);

// production wajib mengisi CORS_ORIGIN (divalidasi di env.ts); dev default ke web lokal
app.use(cors({ origin: env.CORS_ORIGIN.length ? env.CORS_ORIGIN : ["http://localhost:3000"] }));
app.use(requestId);
app.use(recordServerLog);
app.use(express.json());

if (env.NODE_ENV !== "test") {
  app.use(requestLogger);
}

app.get("/api/v1/health", healthHandler);

// F27: saat mode pemeliharaan aktif semua rute selain pengecualian (admin, login, webhook, dll.) dibalas 503
app.use(maintenanceGuard);

// admin dipasang sebelum v1; path admin tak dikenal: tanpa token 401, bukan admin 403, admin 404 (notFound)
app.use("/api/v1/admin", requireAuth, requireRole("admin"), adminAccess, admin);
app.use("/api/v1/merchant", requireAuth, requireRole("merchant"), merchant);
// F21: menu & pesanan meja tanpa login
app.use("/api/v1", table);
app.use("/api/v1", katalog);
app.use("/api/v1", order);
app.use("/api/v1", notifikasi);
app.use("/api/v1", tiket);
app.use("/api/v1", v1);
app.use("/api/v1", meta);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
