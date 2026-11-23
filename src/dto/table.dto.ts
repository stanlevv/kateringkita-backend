import { z } from "zod";
import { quoteSchema } from "./order.dto";

// F21 pesan dari meja. Pesanan tamu: titik temu, waktu ambil, dan promo tidak dipakai (field lain dibuang z.object).
const NAME = "Nama 1–60 karakter.";
export const tableOrderSchema = z.object(
  {
    items: quoteSchema.shape.items,
    note: quoteSchema.shape.note,
    customer_name: z.string({ error: NAME }).trim().min(1, NAME).max(60, NAME),
    customer_phone: quoteSchema.shape.customer_phone,
  },
  { error: "Data pesanan tidak valid." },
);
export type TableOrderInput = z.infer<typeof tableOrderSchema>;

// halaman status pesanan di web setelah bayar; origin dicek terhadap CORS_ORIGIN di service
export const payGuestOrderSchema = z.object(
  { kembali: z.url({ error: "Alamat kembali tidak valid." }) },
  { error: "Data tidak valid." },
);

const LABEL = "Nama meja 1–30 karakter.";
const label = z.string({ error: LABEL }).trim().min(1, LABEL).max(30, LABEL);
export const tableSchema = z.object({ label }, { error: "Data meja tidak valid." });
export const updateTableSchema = z
  .object(
    {
      label: label.optional(),
      is_active: z.boolean({ error: "Status meja tidak valid." }).optional(),
      // QR lama berhenti berlaku (mis. stiker hilang/difoto orang)
      ganti_token: z.literal(true, { error: "Isi true untuk mengganti QR." }).optional(),
    },
    { error: "Data meja tidak valid." },
  )
  .refine((o) => Object.keys(o).length > 0, "Tidak ada perubahan.");
export type UpdateTableInput = z.infer<typeof updateTableSchema>;
