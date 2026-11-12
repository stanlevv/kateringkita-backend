import { z } from "zod";
import { daftarDasar } from "./pesanan.dto";

// Tipe yang benar-benar ditulis ke tabel notifications: order_status (transisi pesanan), promo (promo toko ke pemfavorit),
// info (pengumuman admin). Tambah di sini bila ada INSERT tipe baru.
export const TIPE_NOTIF = ["order_status", "promo", "info"] as const;

// F08 (C-21; D13, D14); type = filter tab Pesanan/Promo/Info di aplikasi, bisa digabung dengan unread
export const daftarNotifSchema = z.object({
  unread: z.enum(["true", "false"], { error: "Filter tidak valid." }).optional(),
  type: z.enum(TIPE_NOTIF, { error: "Tipe notifikasi tidak dikenal." }).optional(),
  page: daftarDasar.page,
  limit: daftarDasar.limit,
});
export type DaftarNotif = z.infer<typeof daftarNotifSchema>;

const NOTIF = "Notifikasi tidak valid.";
const PILIH = "Pilih notifikasi yang ditandai.";
export const tandaiSchema = z.object({
  // elemen dicek di tingkat array agar galat jatuh di fields.ids, bukan ids.0
  ids: z.array(z.unknown(), { error: NOTIF }).min(1, PILIH).max(100, NOTIF)
    .refine((a) => a.every((x) => Number.isInteger(x) && (x as number) >= 1), NOTIF).transform((a) => a as number[]).optional(),
  all: z.literal(true, { error: PILIH }).optional(),
}).refine((b) => (b.ids ? 1 : 0) + (b.all ? 1 : 0) === 1, { path: ["ids"], message: PILIH });
export type Tandai = z.infer<typeof tandaiSchema>;
