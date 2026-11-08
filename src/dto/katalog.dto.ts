import { z } from "zod";

// D10: nilai bukan angka/≤ 0 → bawaan, > 100 → 100 (sama dengan admin F18)
export const halamanSchema = z.object({
  page: z.coerce.number().int().min(1).catch(1),
  limit: z.coerce.number().int().min(1).catch(20).transform((n) => Math.min(n, 100)),
});

export type Halaman = z.infer<typeof halamanSchema>;

const slug = (pesan: string) => z.string({ error: pesan }).optional();
const titik = "Titik temu tidak valid.";

export const katalogQuerySchema = halamanSchema.extend({
  q: z.string({ error: "Pencarian tidak valid." }).trim().max(100, "Pencarian maksimal 100 karakter.").optional(),
  category: slug("Kategori tidak valid."),
  merchant: slug("Toko tidak valid."),
  pickup_point_id: z.coerce.number({ error: titik }).int(titik).min(1, titik).optional(),
  sort: z.enum(["popular", "rating", "price_asc", "price_desc", "newest"], { error: "Urutan tidak dikenal." }).default("popular"),
});

export type KatalogQuery = z.infer<typeof katalogQuerySchema>;
