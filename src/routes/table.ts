// Rute publik pesan dari meja (F21) di /api/v1: menu meja, pesanan tamu, status, dan bayar.
// Alur routes → handlers (table.handler) → services (table.service). Rute kelola meja penjual ada di routes/merchant.ts.
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
 * Router meja (F21, publik, tanpa token login). Pesanan tamu dibaca/dibayar dengan header X-Guest-Token;
 * membuat pesanan dibatasi `mejaLimiter` per token meja.
 */
export const table = Router();

table.get("/tables/:token", getTableMenuHandler);
table.post("/tables/:token/orders", mejaLimiter, validate(tableOrderSchema), createTableOrderHandler);
table.get("/guest/orders/:code", getGuestOrderHandler);
table.post("/guest/orders/:code/pay", validate(payGuestOrderSchema), payGuestOrderHandler);
