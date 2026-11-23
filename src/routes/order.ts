import { Router } from "express";
import { quoteSchema, reviewSchema, vaSchema } from "../dto/order.dto";
import {
  getMyOrderHandler,
  cancelMyOrderHandler,
  payOnlineHandler,
  createOrderHandler,
  createQrisHandler,
  createVaHandler,
  listMyOrdersHandler,
  createReviewHandler,
  midtransNotificationHandler,
  reorderHandler,
  quoteHandler,
  completeMyOrderHandler,
  getMyOrderWhatsappHandler,
} from "../handlers/order.handler";
import { requireAuth, requireRole } from "../middleware/auth";
import { validate } from "../middleware/validate";

// Pesanan pembeli (F06); dipasang di /api/v1 sebelum v1
export const order = Router();
const customerOnly = [requireAuth, requireRole("customer")];

order.post("/orders/quote", ...customerOnly, validate(quoteSchema), quoteHandler);

order.post("/orders", ...customerOnly, createOrderHandler);

order.get("/orders/:code", ...customerOnly, getMyOrderHandler);

order.get("/orders/:code/whatsapp", ...customerOnly, getMyOrderWhatsappHandler);

// F07 (C-14): daftar 3 tab
order.get("/me/orders", ...customerOnly, listMyOrdersHandler);

// F07 (C-15): batal, alasan opsional
order.post("/orders/:code/cancel", ...customerOnly, cancelMyOrderHandler);

// F07 (C-16): pembeli menyelesaikan pesanan siap ambil
order.post("/orders/:code/complete", ...customerOnly, completeMyOrderHandler);

// F13: ulasan per menu untuk pesanan selesai
order.post("/orders/:code/reviews", ...customerOnly, validate(reviewSchema), createReviewHandler);

// F14: susun ulang pesanan lama + quote
order.post("/orders/:code/reorder", ...customerOnly, reorderHandler);

// F10: VA Midtrans untuk pesanan VA (bank dipilih pembeli); notifikasi Midtrans tanpa token, diverifikasi signature
order.post("/orders/:code/va", ...customerOnly, validate(vaSchema), createVaHandler);
// F26: halaman bayar online Snap (QRIS, e-wallet, VA) untuk pesanan payment_method "online"
order.post("/orders/:code/online", ...customerOnly, payOnlineHandler);
// QRIS langsung di aplikasi (Core API) untuk pesanan "online": QR digambar aplikasi, tanpa halaman Snap
order.post("/orders/:code/qris", ...customerOnly, createQrisHandler);
order.post("/payments/midtrans", midtransNotificationHandler);
