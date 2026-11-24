// Isi file: skema zod untuk chat pesanan, yaitu isi pesan yang dikirim (teks dan/atau foto), query cek pesan baru,
// penanda baca, laporan chat, dan query daftar laporan admin. Data yang tidak lolos dijawab 400 beserta pesan per
// kolom. Dipakai handlers/order-chat.handler.ts. Nama kunci = kontrak JSON.
import { z } from "zod";
import { listTicketsSchema } from "./ticket.dto";
import { imageUrlSchema } from "./upload.dto";

const BODY_MSG = "Pesan 1–1000 karakter.";
const AFTER_ID_MSG = "after_id harus bilangan bulat 0 atau lebih.";
const LAST_ID_MSG = "last_id harus bilangan bulat 0 atau lebih.";
const REASON_MSG = "Alasan 5–500 karakter.";

// Teks kosong atau spasi saja dianggap tidak ada teks, supaya pesan foto boleh dikirim tanpa teks.
const optionalBodySchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? null : value),
  z.string({ error: BODY_MSG }).trim().min(1, BODY_MSG).max(1000, BODY_MSG).nullish(),
);

/**
 * Isi `POST …/messages`: `body` 1–1000 karakter setelah spasi di awal dan akhir dibuang, dan/atau `image_url` foto
 * hasil unggahan chat. Pesan wajib punya teks atau foto. Apakah foto itu benar dari folder chat pesanan ini diperiksa
 * validateImageUrl di order-chat.service.
 */
export const sendMessageSchema = z
  .object({ body: optionalBodySchema, image_url: imageUrlSchema })
  .refine((input) => Boolean(input.body || input.image_url), { message: BODY_MSG, path: ["body"] });
/** Isi pesan yang sudah lolos {@link sendMessageSchema}. */
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

/**
 * Query `GET …/messages`: `after_id` opsional. Bila diisi, hanya pesan dengan id lebih besar yang dikirim, supaya cek
 * berkala tiap 5 detik cukup mengambil pesan baru.
 */
export const listMessagesSchema = z.object({
  after_id: z.coerce.number({ error: AFTER_ID_MSG }).int(AFTER_ID_MSG).min(0, AFTER_ID_MSG).optional(),
});

/**
 * Isi `POST …/messages/read`: `last_id` opsional, yaitu id pesan terakhir yang benar-benar tampil di layar. Tanpa
 * `last_id`, semua pesan dianggap sudah dibaca.
 */
export const markReadSchema = z.object({
  last_id: z.number({ error: LAST_ID_MSG }).int(LAST_ID_MSG).min(0, LAST_ID_MSG).optional(),
});

/** Isi `POST …/chat-report`: `reason` 5–500 karakter setelah spasi di awal dan akhir dibuang. */
export const reportChatSchema = z.object({
  reason: z.string({ error: REASON_MSG }).trim().min(5, REASON_MSG).max(500, REASON_MSG),
});

/** Query `GET /admin/chat-reports`: `page` mulai 1 dan `limit` 1–50 (bawaan 20), sama dengan daftar tiket. */
export const listChatReportsSchema = listTicketsSchema;
/** Query daftar laporan chat yang sudah lolos {@link listChatReportsSchema}. */
export type ListChatReportsQuery = z.infer<typeof listChatReportsSchema>;
