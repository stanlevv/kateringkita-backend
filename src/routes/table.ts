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

// F21 pesan dari meja (publik, tanpa token login). Pesanan tamu dibaca/dibayar dengan header X-Guest-Token.
export const table = Router();

table.get("/tables/:token", getTableMenuHandler);
table.post("/tables/:token/orders", mejaLimiter, validate(tableOrderSchema), createTableOrderHandler);
table.get("/guest/orders/:code", getGuestOrderHandler);
table.post("/guest/orders/:code/pay", validate(payGuestOrderSchema), payGuestOrderHandler);
