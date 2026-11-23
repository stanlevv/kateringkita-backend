import { z } from "zod";
import { listQueryBase } from "./order.dto";
import { Status } from "../services/order-status.service";

// F07 D12: query GET /merchant/orders
const STATUS: Status[] = ["holding", "confirmed", "cooking", "ready", "completed", "cancelled", "expired"];
const INVALID_STATUS = "Status tidak dikenal.";
export const merchantOrdersQuerySchema = z.object({
  // daftar dipisah koma; kosong = semua
  status: z
    .string({ error: INVALID_STATUS })
    .optional()
    .transform((s) => (s ? s.split(",").map((x) => x.trim()) : []) as Status[])
    .refine((a) => a.every((x) => STATUS.includes(x)), INVALID_STATUS),
  date: z.iso.date({ error: "Tanggal tidak valid." }).optional(),
  ...listQueryBase,
});
export type MerchantOrdersQuery = z.infer<typeof merchantOrdersQuerySchema>;
