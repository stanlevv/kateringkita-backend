// Isi file: daftar alamat (rute) notifikasi in-app di /api/v1. Lapisan pertama dari alur routes → handlers
// (notification.handler) → services (notification.service) → database: di sini ditentukan siapa yang boleh masuk.
import { Router } from "express";
import {
  listNotificationsHandler,
  markAsReadHandler,
  registerPushTokenHandler,
  unregisterPushTokenHandler,
} from "../handlers/notification.handler";
import { pushTokenSchema } from "../dto/push-token.dto";
import { requireAuth, requireRole } from "../middleware/auth";
import { validate } from "../middleware/validate";

/**
 * Router notifikasi in-app. Semua peran yang login (pembeli, penjual, admin) boleh memakai, dan masing-masing hanya
 * melihat serta menandai notifikasinya sendiri. Tanpa token login dijawab 401.
 */
export const notification = Router();

notification.get("/me/notifications", requireAuth, listNotificationsHandler);

notification.post("/me/notifications/read", requireAuth, markAsReadHandler);

// Token push perangkat: hanya pembeli (penjual dan admin dijawab 403).
notification.put(
  "/me/push-token",
  requireAuth,
  requireRole("customer"),
  validate(pushTokenSchema),
  registerPushTokenHandler,
);

notification.delete("/me/push-token", requireAuth, requireRole("customer"), unregisterPushTokenHandler);
