import { z } from "zod";

// D10: nilai bukan angka/≤ 0 → bawaan, > 100 → 100 (sama dengan admin F18)
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).catch(1),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .catch(20)
    .transform((limit) => Math.min(limit, 100)),
});

export type Pagination = z.infer<typeof paginationSchema>;

const optionalSlug = (message: string) => z.string({ error: message }).optional();
const PICKUP_POINT_MSG = "Titik temu tidak valid.";

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

export type CatalogQuery = z.infer<typeof catalogQuerySchema>;
