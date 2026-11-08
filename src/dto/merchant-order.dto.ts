import { z } from "zod";
import { daftarDasar } from "./pesanan.dto";
import { Status } from "../services/pesanan-status.service";

// F07 D12: query GET /merchant/orders
const STATUS: Status[] = ["holding", "confirmed", "cooking", "ready", "completed", "cancelled", "expired"];
const SALAH_STATUS = "Status tidak dikenal.";
export const daftarTokoSchema = z.object({
  // daftar dipisah koma; kosong = semua
  status: z.string({ error: SALAH_STATUS }).optional()
    .transform((s) => (s ? s.split(",").map((x) => x.trim()) : []) as Status[])
    .refine((a) => a.every((x) => STATUS.includes(x)), SALAH_STATUS),
  date: z.iso.date({ error: "Tanggal tidak valid." }).optional(),
  ...daftarDasar,
});
export type DaftarToko = z.infer<typeof daftarTokoSchema>;
