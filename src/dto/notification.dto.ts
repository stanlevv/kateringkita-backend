// Isi file: skema zod untuk query daftar notifikasi dan isi permintaan "tandai sudah dibaca". zod = pustaka yang
// memeriksa bentuk data masuk; data yang tidak lolos dijawab 400 beserta pesan per kolom. Dipakai
// handlers/notification.handler.ts sebelum memanggil notification.service. Nama kunci di sini adalah kontrak JSON.
import { z } from "zod";
import { listQueryBase } from "./order.dto";

/**
 * Tipe notifikasi yang benar-benar ditulis ke tabel `notifications`: `order_status` (status pesanan berubah), `promo`
 * (promo toko untuk pembeli yang memfavoritkan menunya), `info` (pengumuman admin, serta balasan atau penutupan tiket
 * bantuan), `moderation` (foto menu penjual dihapus admin), dan `chat_message` (pembeli mengirim pesan di chat pesanan,
 * untuk penjual). Tambahkan di sini bila ada tipe baru yang disimpan.
 */
export const NOTIFICATION_TYPES = ["order_status", "promo", "info", "moderation", "chat_message"] as const;

/**
 * Query `GET /me/notifications`: `unread` ("true" = hanya yang belum dibaca), `type` (filter tab Pesanan/Promo/Info
 * di aplikasi; boleh digabung dengan `unread`), `page` mulai 1, dan `limit` 1–100 (bawaan 20).
 */
export const listNotificationsSchema = z.object({
  unread: z.enum(["true", "false"], { error: "Filter tidak valid." }).optional(),
  type: z.enum(NOTIFICATION_TYPES, { error: "Tipe notifikasi tidak dikenal." }).optional(),
  page: listQueryBase.page,
  limit: listQueryBase.limit,
});
/** Query daftar notifikasi yang sudah lolos {@link listNotificationsSchema}. */
export type ListNotificationsQuery = z.infer<typeof listNotificationsSchema>;

// Pesan galat untuk isi "tandai sudah dibaca".
const INVALID_NOTIFICATION_MSG = "Notifikasi tidak valid.";
const SELECT_NOTIFICATION_MSG = "Pilih notifikasi yang ditandai.";
/**
 * Isi `POST /me/notifications/read`: isi tepat salah satu, `ids` (1–100 id notifikasi, bilangan bulat ≥ 1) untuk
 * menandai sebagian, atau `all: true` untuk menandai semuanya. Mengisi keduanya atau tidak mengisi apa pun ditolak.
 */
export const markAsReadSchema = z
  .object({
    // Isi daftar dicek sekaligus di tingkat daftar, supaya pesan galat tampil di kolom `ids`, bukan `ids.0`.
    ids: z
      .array(z.unknown(), { error: INVALID_NOTIFICATION_MSG })
      .min(1, SELECT_NOTIFICATION_MSG)
      .max(100, INVALID_NOTIFICATION_MSG)
      .refine((ids) => ids.every((id) => Number.isInteger(id) && (id as number) >= 1), INVALID_NOTIFICATION_MSG)
      .transform((ids) => ids as number[])
      .optional(),
    all: z.literal(true, { error: SELECT_NOTIFICATION_MSG }).optional(),
  })
  .refine((body) => (body.ids ? 1 : 0) + (body.all ? 1 : 0) === 1, { path: ["ids"], message: SELECT_NOTIFICATION_MSG });
/** Isi "tandai sudah dibaca" yang sudah lolos {@link markAsReadSchema}. */
export type MarkAsReadInput = z.infer<typeof markAsReadSchema>;
