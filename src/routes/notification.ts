import { Router } from "express";
import { listNotificationsHandler, markAsReadHandler } from "../handlers/notification.handler";
import { requireAuth } from "../middleware/auth";

// F08 (C-21, R-10): notifikasi in-app milik pengguna yang login (semua peran; penjual/admin hanya mendapat daftar kosong, D13)
export const notification = Router();

notification.get("/me/notifications", requireAuth, listNotificationsHandler);

notification.post("/me/notifications/read", requireAuth, markAsReadHandler);
