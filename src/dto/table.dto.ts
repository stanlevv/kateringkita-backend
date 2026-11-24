// Isi file: skema zod (aturan bentuk data) untuk fitur pesan dari meja: pesanan tamu, bayar tamu, dan kelola meja
// oleh penjual. Dipakai `validate` di routes/table.ts dan routes/merchant.ts sebelum handler meja dipanggil.
import { z } from "zod";
import { quoteSchema } from "./order.dto";

// Pesanan tamu tidak memakai titik temu, waktu ambil, dan voucher; kolom lain yang dikirim dibuang z.object.
const NAME_MSG = "Nama 1–60 karakter.";
/**
 * Isi `POST /tables/:token/orders`: baris menu, catatan, dan nomor HP memakai aturan {@link quoteSchema}; nama
 * pemesan wajib 1–60 karakter karena tamu tidak login.
 */
export const tableOrderSchema = z.object(
  {
    items: quoteSchema.shape.items,
    note: quoteSchema.shape.note,
    customer_name: z.string({ error: NAME_MSG }).trim().min(1, NAME_MSG).max(60, NAME_MSG),
    customer_phone: quoteSchema.shape.customer_phone,
  },
  { error: "Data pesanan tidak valid." },
);
/** Isi pesanan tamu yang sudah lolos {@link tableOrderSchema}. */
export type TableOrderInput = z.infer<typeof tableOrderSchema>;

/**
 * Isi `POST /guest/orders/:code/pay`: `kembali` wajib, berisi alamat halaman status pesanan di web setelah bayar.
 * Di service, alamat itu diperiksa harus alamat web KateringKita sendiri (CORS_ORIGIN).
 */
export const payGuestOrderSchema = z.object(
  { kembali: z.url({ error: "Alamat kembali tidak valid." }) },
  { error: "Data tidak valid." },
);

const LABEL_MSG = "Nama meja 1–30 karakter.";
// Aturan nama meja, dipakai saat membuat dan mengubah meja.
const label = z.string({ error: LABEL_MSG }).trim().min(1, LABEL_MSG).max(30, LABEL_MSG);
/** Isi `POST /merchant/tables`: nama meja (`label`) 1–30 karakter. */
export const tableSchema = z.object({ label }, { error: "Data meja tidak valid." });
/**
 * Isi `PATCH /merchant/tables/:id`: minimal satu dari `label`, `is_active`, atau `ganti_token: true` (membuat QR baru
 * dan mematikan QR lama). Isi kosong ditolak dengan pesan "Tidak ada perubahan.".
 */
export const updateTableSchema = z
  .object(
    {
      label: label.optional(),
      is_active: z.boolean({ error: "Status meja tidak valid." }).optional(),
      // QR lama berhenti berlaku, misalnya karena stiker hilang atau difoto orang.
      ganti_token: z.literal(true, { error: "Isi true untuk mengganti QR." }).optional(),
    },
    { error: "Data meja tidak valid." },
  )
  .refine((changes) => Object.keys(changes).length > 0, "Tidak ada perubahan.");
/** Perubahan meja yang sudah lolos {@link updateTableSchema}. */
export type UpdateTableInput = z.infer<typeof updateTableSchema>;
