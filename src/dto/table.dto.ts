// Skema zod untuk fitur pesan dari meja (F21): pesanan tamu, bayar tamu, dan kelola meja oleh penjual.
// Dipakai `validate` di routes/table.ts dan routes/merchant.ts sebelum handler meja dipanggil.
import { z } from "zod";
import { quoteSchema } from "./order.dto";

// F21 pesan dari meja. Pesanan tamu: titik temu, waktu ambil, dan promo tidak dipakai (field lain dibuang z.object).
const NAME = "Nama 1–60 karakter.";
/**
 * Body `POST /tables/:token/orders`: baris menu, catatan, dan nomor HP memakai aturan {@link quoteSchema};
 * nama pemesan wajib 1–60 karakter karena tamu tidak login.
 */
export const tableOrderSchema = z.object(
  {
    items: quoteSchema.shape.items,
    note: quoteSchema.shape.note,
    customer_name: z.string({ error: NAME }).trim().min(1, NAME).max(60, NAME),
    customer_phone: quoteSchema.shape.customer_phone,
  },
  { error: "Data pesanan tidak valid." },
);
/** Data pesanan tamu yang sudah lolos {@link tableOrderSchema}. */
export type TableOrderInput = z.infer<typeof tableOrderSchema>;

/**
 * Body `POST /guest/orders/:code/pay`: `kembali` wajib, berisi URL halaman status pesanan di web setelah bayar.
 * Origin-nya dicek terhadap CORS_ORIGIN di service.
 */
export const payGuestOrderSchema = z.object(
  { kembali: z.url({ error: "Alamat kembali tidak valid." }) },
  { error: "Data tidak valid." },
);

const LABEL = "Nama meja 1–30 karakter.";
const label = z.string({ error: LABEL }).trim().min(1, LABEL).max(30, LABEL);
/** Body `POST /merchant/tables`: nama meja (`label`) 1–30 karakter. */
export const tableSchema = z.object({ label }, { error: "Data meja tidak valid." });
/**
 * Body `PATCH /merchant/tables/:id`: minimal satu dari `label`, `is_active`, atau `ganti_token: true`
 * (membuat QR baru dan mematikan QR lama). Body kosong ditolak "Tidak ada perubahan.".
 */
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
/** Perubahan meja yang sudah lolos {@link updateTableSchema}. */
export type UpdateTableInput = z.infer<typeof updateTableSchema>;
