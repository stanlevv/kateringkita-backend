// Isi file: daftar alamat (rute) tiket bantuan sisi pembeli di /api/v1. Lapisan pertama dari alur routes → handlers
// (ticket.handler) → services (ticket.service) → database: di sini ditentukan siapa yang boleh masuk. Sisi admin ada
// di routes/admin.ts (/admin/tickets).
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

/**
 * Router tiket bantuan pembeli. Semua rute hanya untuk pembeli yang login (tanpa token 401, peran lain 403), dan
 * pembeli hanya bisa melihat serta mengubah tiketnya sendiri.
 */
export const ticket = Router();
const customerOnly = [requireAuth, requireRole("customer")];

ticket.get("/me/tickets", ...customerOnly, listMyTicketsHandler);

// Paling banyak 10 tiket baru per pembeli per jam (hanya tiket yang berhasil dibuat yang dihitung).
ticket.post("/me/tickets", ...customerOnly, ticketLimiter, createTicketHandler);

// Membuka tiket sekaligus menandai balasan admin sudah dibaca.
ticket.get("/me/tickets/:code", ...customerOnly, getMyTicketHandler);

ticket.post("/me/tickets/:code/messages", ...customerOnly, replyMyTicketHandler);

ticket.post("/me/tickets/:code/close", ...customerOnly, closeMyTicketHandler);
