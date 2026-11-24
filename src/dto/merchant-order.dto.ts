// Isi file: skema zod (aturan bentuk data) untuk query daftar pesanan toko (`GET /merchant/orders`). Dipakai
// merchant.handler (lapisan handlers) sebelum memanggil merchant-order.service.
import { z } from "zod";
import { listQueryBase } from "./order.dto";
import { Status } from "../services/order-status.service";

// Semua status pesanan yang boleh dipakai sebagai saringan.
const VALID_STATUSES: Status[] = ["holding", "confirmed", "cooking", "ready", "completed", "cancelled", "expired"];
const INVALID_STATUS_MSG = "Status tidak dikenal.";
/**
 * Query daftar pesanan toko: `status` berisi status dipisah koma (kosong = semua, status tak dikenal → 400),
 * `date` tanggal WIB `YYYY-MM-DD`, ditambah field bersama {@link listQueryBase}.
 */
export const merchantOrdersQuerySchema = z.object({
  // Daftar status dipisah koma, contoh "holding,confirmed"; kosong = semua status.
  status: z
    .string({ error: INVALID_STATUS_MSG })
    .optional()
    .transform((text) => (text ? text.split(",").map((status) => status.trim()) : []) as Status[])
    .refine((statuses) => statuses.every((status) => VALID_STATUSES.includes(status)), INVALID_STATUS_MSG),
  date: z.iso.date({ error: "Tanggal tidak valid." }).optional(),
  ...listQueryBase,
});
/** Query daftar pesanan toko yang sudah lolos {@link merchantOrdersQuerySchema}. */
export type MerchantOrdersQuery = z.infer<typeof merchantOrdersQuerySchema>;
