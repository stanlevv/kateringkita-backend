// Isi file: daftar alamat (rute) pesanan pembeli di /api/v1: quote, checkout, detail, daftar, batal, selesai,
// ulasan, pesan lagi, dan bayar. Lapisan pertama dari alur routes → handlers (order.handler) → services
// (order.service, va-payment.service) → database: menentukan siapa yang boleh masuk dan skema isi permintaan.
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

/**
 * Router pesanan pembeli; dipasang di /api/v1. Semua rute wajib login sebagai pembeli, kecuali
 * `POST /payments/midtrans`: webhook (pemberitahuan otomatis) dari server Midtrans yang tidak membawa token login,
 * dan keasliannya diperiksa lewat tanda tangan digital (signature) di service.
 */
export const order = Router();
const customerOnly = [requireAuth, requireRole("customer")];

order.post("/orders/quote", ...customerOnly, validate(quoteSchema), quoteHandler);

order.post("/orders", ...customerOnly, createOrderHandler);

order.get("/orders/:code", ...customerOnly, getMyOrderHandler);

order.get("/orders/:code/whatsapp", ...customerOnly, getMyOrderWhatsappHandler);

// Daftar pesanan pembeli dalam 3 tab: aktif, selesai, batal.
order.get("/me/orders", ...customerOnly, listMyOrdersHandler);

// Batalkan pesanan; alasan boleh kosong.
order.post("/orders/:code/cancel", ...customerOnly, cancelMyOrderHandler);

// Pembeli menandai pesanan yang siap diambil sudah ia terima.
order.post("/orders/:code/complete", ...customerOnly, completeMyOrderHandler);

// Ulasan per menu untuk pesanan yang sudah selesai.
order.post("/orders/:code/reviews", ...customerOnly, validate(reviewSchema), createReviewHandler);

// Pesan lagi: susun ulang pesanan lama lalu hitung harganya.
order.post("/orders/:code/reorder", ...customerOnly, reorderHandler);

// Pembayaran: Virtual Account Midtrans untuk pesanan VA (bank dipilih pembeli).
order.post("/orders/:code/va", ...customerOnly, validate(vaSchema), createVaHandler);
// Halaman bayar online Snap (QRIS, e-wallet, VA) untuk pesanan dengan payment_method "online".
order.post("/orders/:code/online", ...customerOnly, payOnlineHandler);
// QRIS langsung di aplikasi untuk pesanan "online": kode QR digambar aplikasi, tanpa halaman Snap.
order.post("/orders/:code/qris", ...customerOnly, createQrisHandler);
// Webhook pembayaran dari Midtrans, tanpa login (lihat keterangan router di atas).
order.post("/payments/midtrans", midtransNotificationHandler);
