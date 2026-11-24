// Isi file: skema zod untuk chat pesanan, yaitu isi pesan yang dikirim dan query cek pesan baru. Data yang tidak lolos
// dijawab 400 beserta pesan per kolom. Dipakai handlers/order-chat.handler.ts. Nama kunci = kontrak JSON.
import { z } from "zod";

const BODY_MSG = "Pesan 1–1000 karakter.";
const AFTER_ID_MSG = "after_id harus bilangan bulat 0 atau lebih.";

/** Isi `POST /orders/:code/messages`: `body` 1–1000 karakter setelah spasi di awal dan akhir dibuang. */
export const sendMessageSchema = z.object({
  body: z.string({ error: BODY_MSG }).trim().min(1, BODY_MSG).max(1000, BODY_MSG),
});
/** Isi pesan yang sudah lolos {@link sendMessageSchema}. */
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

/**
 * Query `GET /orders/:code/messages`: `after_id` opsional. Bila diisi, hanya pesan dengan id lebih besar yang
 * dikirim, supaya cek berkala tiap 5 detik cukup mengambil pesan baru.
 */
export const listMessagesSchema = z.object({
  after_id: z.coerce.number({ error: AFTER_ID_MSG }).int(AFTER_ID_MSG).min(0, AFTER_ID_MSG).optional(),
});
