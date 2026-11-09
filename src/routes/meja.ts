import { Router } from "express";
import { bayarMejaSchema, pesananMejaSchema } from "../dto/meja.dto";
import { bayarMejaHandler, menuMejaHandler, pesanMejaHandler, statusMejaHandler } from "../handlers/meja.handler";
import { mejaLimiter } from "../middleware/rateLimiter";
import { validate } from "../middleware/validate";

// F21 pesan dari meja (publik, tanpa token login). Pesanan tamu dibaca/dibayar dengan header X-Guest-Token.
export const meja = Router();

meja.get("/tables/:token", menuMejaHandler);
meja.post("/tables/:token/orders", mejaLimiter, validate(pesananMejaSchema), pesanMejaHandler);
meja.get("/guest/orders/:code", statusMejaHandler);
meja.post("/guest/orders/:code/pay", validate(bayarMejaSchema), bayarMejaHandler);
