// Isi file: daftar kategori dan status tiket bantuan, serta skema zod untuk membuat tiket, membalas, dan query
// daftar tiket (pembeli dan admin). zod = pustaka yang memeriksa bentuk data masuk; data yang tidak lolos dijawab 400
// beserta pesan per kolom. Dipakai handlers/ticket.handler.ts dan admin-ticket.service. Nama kunci = kontrak JSON.
import { z } from "zod";

/** Kategori tiket, tampil di aplikasi sebagai Akun, Pembayaran, Pesanan, Penjual, Aplikasi, Lainnya. */
export const TICKET_CATEGORIES = ["akun", "pembayaran", "pesanan", "penjual", "aplikasi", "lainnya"] as const;
/**
 * Status tiket: `open` = menunggu admin, `answered` = admin sudah membalas (menunggu pembeli), `closed` = selesai.
 */
export const TICKET_STATUSES = ["open", "answered", "closed"] as const;

const CATEGORY_MSG = "Pilih kategori.";
const SUBJECT_MSG = "Judul 3–120 karakter.";
const MESSAGE_MSG = "Pesan 5–2000 karakter.";
const REPLY_MSG = "Pesan 1–2000 karakter.";
const ORDER_MSG = "Pesanan tidak ditemukan.";
const SEARCH_MSG = "Pencarian maksimal 100 karakter.";

/**
 * Isi `POST /me/tickets`: `category`, `subject` (judul 3–120 karakter), `message` (pesan pertama 5–2000 karakter),
 * dan `order_code` opsional. Kode pesanan kosong atau berisi spasi saja dianggap tanpa pesanan; kepemilikan pesanan
 * dicek di service, dan pesanan milik orang lain dijawab dengan pesan yang sama seperti pesanan yang tidak ada.
 */
export const createTicketSchema = z.object({
  category: z.enum(TICKET_CATEGORIES, { error: CATEGORY_MSG }),
  subject: z.string({ error: SUBJECT_MSG }).trim().min(3, SUBJECT_MSG).max(120, SUBJECT_MSG),
  message: z.string({ error: MESSAGE_MSG }).trim().min(5, MESSAGE_MSG).max(2000, MESSAGE_MSG),
  order_code: z
    .string({ error: ORDER_MSG })
    .trim()
    .max(20, ORDER_MSG)
    .nullish()
    .transform((orderCode) => orderCode || null),
});
/** Isi tiket baru yang sudah lolos {@link createTicketSchema}. */
export type CreateTicketInput = z.infer<typeof createTicketSchema>;

/** Isi balasan tiket dari pembeli maupun admin: `body` 1–2000 karakter. */
export const replyTicketSchema = z.object({
  body: z.string({ error: REPLY_MSG }).trim().min(1, REPLY_MSG).max(2000, REPLY_MSG),
});

// Kolom halaman: `page` mulai 1, `limit` 1–50 dengan bawaan 20. Nilai yang tidak valid memakai bawaan, dan `limit` di
// atas 50 dipotong menjadi 50 (sama dengan query halaman di katalog dan admin).
const paginationFields = {
  page: z.coerce.number().int().min(1).catch(1),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .catch(20)
    .transform((limit) => Math.min(limit, 50)),
};
/** Query `GET /me/tickets`: hanya `page` dan `limit`. */
export const listTicketsSchema = z.object(paginationFields);
/** Query daftar tiket pembeli yang sudah lolos {@link listTicketsSchema}. */
export type ListTicketsQuery = z.infer<typeof listTicketsSchema>;

/**
 * Query `GET /admin/tickets`: `status` (kosong = tab "Semua", tanpa saringan), `q` (kata cari, maksimal 100 karakter),
 * `page`, dan `limit`.
 */
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
/** Query daftar tiket admin yang sudah lolos {@link listAdminTicketsSchema}. */
export type ListAdminTicketsQuery = z.infer<typeof listAdminTicketsSchema>;
