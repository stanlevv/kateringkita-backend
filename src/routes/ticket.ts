import { Router } from "express";
import {
  getMyTicketHandler,
  replyMyTicketHandler,
  createTicketHandler,
  listMyTicketsHandler,
  closeMyTicketHandler,
} from "../handlers/ticket.handler";
import { requireAuth, requireRole } from "../middleware/auth";
import { ticketLimiter } from "../middleware/rate-limiter";

// Tiket bantuan (CS) pembeli ↔ tim admin; dipasang di /api/v1 sebelum v1. Sisi admin: routes/admin.ts (/admin/tickets).
export const ticket = Router();
const customerOnly = [requireAuth, requireRole("customer")];

ticket.get("/me/tickets", ...customerOnly, listMyTicketsHandler);

// 10 tiket baru per pembeli per jam (hanya yang berhasil dibuat dihitung)
ticket.post("/me/tickets", ...customerOnly, ticketLimiter, createTicketHandler);

// sekaligus menandai balasan admin sudah dibaca
ticket.get("/me/tickets/:code", ...customerOnly, getMyTicketHandler);

ticket.post("/me/tickets/:code/messages", ...customerOnly, replyMyTicketHandler);

ticket.post("/me/tickets/:code/close", ...customerOnly, closeMyTicketHandler);
