import { z } from "zod";

// Tiket bantuan (CS). Kategori tampil di aplikasi: Akun, Pembayaran, Pesanan, Penjual, Aplikasi, Lainnya.
export const TICKET_CATEGORIES = ["akun", "pembayaran", "pesanan", "penjual", "aplikasi", "lainnya"] as const;
// open = menunggu admin, answered = admin sudah membalas (menunggu pembeli), closed = selesai
export const TICKET_STATUSES = ["open", "answered", "closed"] as const;

const CATEGORY_MSG = "Pilih kategori.";
const SUBJECT_MSG = "Judul 3–120 karakter.";
const MESSAGE_MSG = "Pesan 5–2000 karakter.";
const REPLY_MSG = "Pesan 1–2000 karakter.";
const ORDER_MSG = "Pesanan tidak ditemukan.";
const SEARCH_MSG = "Pencarian maksimal 100 karakter.";

export const createTicketSchema = z.object({
  category: z.enum(TICKET_CATEGORIES, { error: CATEGORY_MSG }),
  subject: z.string({ error: SUBJECT_MSG }).trim().min(3, SUBJECT_MSG).max(120, SUBJECT_MSG),
  message: z.string({ error: MESSAGE_MSG }).trim().min(5, MESSAGE_MSG).max(2000, MESSAGE_MSG),
  // opsional: kosong/spasi = tanpa pesanan; kepemilikan dicek di service (bukan milik → pesan yang sama)
  order_code: z
    .string({ error: ORDER_MSG })
    .trim()
    .max(20, ORDER_MSG)
    .nullish()
    .transform((orderCode) => orderCode || null),
});
export type CreateTicketInput = z.infer<typeof createTicketSchema>;

// balasan pembeli & admin
export const replyTicketSchema = z.object({
  body: z.string({ error: REPLY_MSG }).trim().min(1, REPLY_MSG).max(2000, REPLY_MSG),
});

// limit 1–50, bawaan 20: nilai tak valid → bawaan, > 50 → 50 (pola halamanSchema katalog & admin)
const paginationFields = {
  page: z.coerce.number().int().min(1).catch(1),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .catch(20)
    .transform((limit) => Math.min(limit, 50)),
};
export const listTicketsSchema = z.object(paginationFields);
export type ListTicketsQuery = z.infer<typeof listTicketsSchema>;

// GET /admin/tickets; status kosong (tab "Semua") = tanpa filter
export const listAdminTicketsSchema = z.object({
  status: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.enum(TICKET_STATUSES, { error: "Status tidak dikenal." }).optional(),
  ),
  q: z
    .string({ error: SEARCH_MSG })
    .trim()
    .max(100, SEARCH_MSG)
    .optional()
    .transform((search) => search || undefined),
  ...paginationFields,
});
export type ListAdminTicketsQuery = z.infer<typeof listAdminTicketsSchema>;
