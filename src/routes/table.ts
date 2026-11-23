// Isi file: daftar alamat (rute) publik fitur pesan dari meja di /api/v1: menu meja, pesanan tamu, status, dan bayar.
// Lapisan pertama dari alur routes → handlers (table.handler) → services (table.service) → database. Rute kelola
// meja milik penjual ada di routes/merchant.ts.
import { Router } from "express";
import { payGuestOrderSchema, tableOrderSchema } from "../dto/table.dto";
import {
  payGuestOrderHandler,
  getTableMenuHandler,
  createTableOrderHandler,
  getGuestOrderHandler,
} from "../handlers/table.handler";
import { mejaLimiter } from "../middleware/rateLimiter";
import { validate } from "../middleware/validate";

/**
 * Router meja (publik, tanpa login). Pesanan tamu dibaca dan dibayar dengan header X-Guest-Token. Membuat pesanan
 * dibatasi `mejaLimiter` (batas jumlah permintaan per token meja dalam waktu tertentu) supaya tidak dibanjiri.
 */
export const table = Router();

table.get("/tables/:token", getTableMenuHandler);
table.post("/tables/:token/orders", mejaLimiter, validate(tableOrderSchema), createTableOrderHandler);
table.get("/guest/orders/:code", getGuestOrderHandler);
table.post("/guest/orders/:code/pay", validate(payGuestOrderSchema), payGuestOrderHandler);
