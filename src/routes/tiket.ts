import { Router } from "express";
import {
  bacaTiketSayaHandler, balasTiketSayaHandler, buatTiketHandler, daftarTiketSayaHandler, tutupTiketSayaHandler,
} from "../handlers/tiket.handler";
import { requireAuth, requireRole } from "../middleware/auth";
import { tiketLimiter } from "../middleware/rateLimiter";

// Tiket bantuan (CS) pembeli ↔ tim admin; dipasang di /api/v1 sebelum v1. Sisi admin: routes/admin.ts (/admin/tickets).
export const tiket = Router();
const pembeli = [requireAuth, requireRole("customer")];

tiket.get("/me/tickets", ...pembeli, daftarTiketSayaHandler);

// 10 tiket baru per pembeli per jam (hanya yang berhasil dibuat dihitung)
tiket.post("/me/tickets", ...pembeli, tiketLimiter, buatTiketHandler);

// sekaligus menandai balasan admin sudah dibaca
tiket.get("/me/tickets/:code", ...pembeli, bacaTiketSayaHandler);

tiket.post("/me/tickets/:code/messages", ...pembeli, balasTiketSayaHandler);

tiket.post("/me/tickets/:code/close", ...pembeli, tutupTiketSayaHandler);
