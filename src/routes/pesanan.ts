import { Router } from "express";
import { quoteSchema } from "../dto/pesanan.dto";
import {
  bacaPesananHandler, batalkanHandler, buatPesananHandler, daftarPesananSayaHandler, quoteHandler, selesaikanHandler, waPesananHandler,
} from "../handlers/pesanan.handler";
import { requireAuth, requireRole } from "../middleware/auth";
import { validate } from "../middleware/validate";

// Pesanan pembeli (F06); dipasang di /api/v1 sebelum v1
export const pesanan = Router();
const pembeli = [requireAuth, requireRole("customer")];

pesanan.post("/orders/quote", ...pembeli, validate(quoteSchema), quoteHandler);

pesanan.post("/orders", ...pembeli, buatPesananHandler);

pesanan.get("/orders/:code", ...pembeli, bacaPesananHandler);

pesanan.get("/orders/:code/whatsapp", ...pembeli, waPesananHandler);

// F07 (C-14): daftar 3 tab
pesanan.get("/me/orders", ...pembeli, daftarPesananSayaHandler);

// F07 (C-15): batal, alasan opsional
pesanan.post("/orders/:code/cancel", ...pembeli, batalkanHandler);

// F07 (C-16): pembeli menyelesaikan pesanan siap ambil
pesanan.post("/orders/:code/complete", ...pembeli, selesaikanHandler);
