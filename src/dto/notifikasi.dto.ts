import { z } from "zod";
import { daftarDasar } from "./pesanan.dto";

// F08 (C-21; D13, D14)
export const daftarNotifSchema = z.object({
  unread: z.enum(["true", "false"], { error: "Filter tidak valid." }).optional(),
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
