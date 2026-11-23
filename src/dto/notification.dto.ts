import { z } from "zod";
import { listQueryBase } from "./order.dto";

// Tipe yang benar-benar ditulis ke tabel notifications: order_status (transisi pesanan), promo (promo toko ke pemfavorit),
// info (pengumuman admin; balasan/penutupan tiket bantuan dengan data.ticket_code). Tambah di sini bila ada INSERT tipe baru.
export const NOTIFICATION_TYPES = ["order_status", "promo", "info", "moderation"] as const;

// F08 (C-21; D13, D14); type = filter tab Pesanan/Promo/Info di aplikasi, bisa digabung dengan unread
export const listNotificationsSchema = z.object({
  unread: z.enum(["true", "false"], { error: "Filter tidak valid." }).optional(),
  type: z.enum(NOTIFICATION_TYPES, { error: "Tipe notifikasi tidak dikenal." }).optional(),
  page: listQueryBase.page,
  limit: listQueryBase.limit,
});
export type ListNotificationsQuery = z.infer<typeof listNotificationsSchema>;

const INVALID_NOTIFICATION_MSG = "Notifikasi tidak valid.";
const SELECT_NOTIFICATION_MSG = "Pilih notifikasi yang ditandai.";
export const markAsReadSchema = z
  .object({
    // elemen dicek di tingkat array agar galat jatuh di fields.ids, bukan ids.0
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
export type MarkAsReadInput = z.infer<typeof markAsReadSchema>;
