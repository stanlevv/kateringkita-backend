// Isi file: aturan bentuk query string katalog (halaman, pencarian, filter, urutan). Dipakai
// handlers/catalog.handler.ts sebelum memanggil service. Skema ditulis dengan zod, pustaka pemeriksa bentuk data:
// nilai yang tidak sesuai aturan ditolak dengan pesan galat per kolom (400).
import { z } from "zod";

/**
 * Aturan paginasi `page` dan `limit` dari query string (teks diubah ke angka). Nilai yang tidak bisa dipakai tidak
 * ditolak, tetapi diganti bawaan: `page` bukan bilangan bulat ≥ 1 menjadi 1, `limit` bukan bilangan bulat ≥ 1 menjadi
 * 20, dan `limit` di atas 100 dipotong jadi 100 (sama dengan daftar admin).
 */
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).catch(1),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .catch(20)
    .transform((limit) => Math.min(limit, 100)),
});

/** Nomor halaman dan jumlah baris per halaman yang sudah lolos {@link paginationSchema}. */
export type Pagination = z.infer<typeof paginationSchema>;

// Slug opsional (nama di URL, contoh `nasi-kotak`) dengan pesan galat sendiri.
const optionalSlug = (message: string) => z.string({ error: message }).optional();
const PICKUP_POINT_MSG = "Titik temu tidak valid.";

/**
 * Aturan query string GET /menus: paginasi ditambah kata cari `q` (paling banyak 100 huruf setelah spasi di ujung
 * dibuang), slug kategori, slug toko, id titik temu (bilangan bulat ≥ 1), dan urutan (bawaan `popular`).
 */
export const catalogQuerySchema = paginationSchema.extend({
  q: z.string({ error: "Pencarian tidak valid." }).trim().max(100, "Pencarian maksimal 100 karakter.").optional(),
  category: optionalSlug("Kategori tidak valid."),
  merchant: optionalSlug("Toko tidak valid."),
  pickup_point_id: z.coerce
    .number({ error: PICKUP_POINT_MSG })
    .int(PICKUP_POINT_MSG)
    .min(1, PICKUP_POINT_MSG)
    .optional(),
  sort: z
    .enum(["popular", "rating", "price_asc", "price_desc", "newest"], { error: "Urutan tidak dikenal." })
    .default("popular"),
});

/** Query katalog yang sudah lolos {@link catalogQuerySchema}. */
export type CatalogQuery = z.infer<typeof catalogQuerySchema>;
