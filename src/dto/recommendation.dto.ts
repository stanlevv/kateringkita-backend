// Isi file: aturan bentuk body POST /assistant/recommendations, yaitu kebutuhan pembeli dalam bahasa bebas ditambah
// batasan opsional. Dipakai middleware validate di routes/catalog.ts sebelum handler berjalan. Skema memakai zod,
// pustaka pemeriksa bentuk data: body yang tidak sesuai ditolak 400 dengan pesan galat per kolom.
import { z } from "zod";

const QUESTION_MSG = "Ceritakan kebutuhanmu 3–500 karakter.";
const BUDGET_MSG = "Anggaran Rp 1.000–100.000.000.";
const PORTIONS_MSG = "Jumlah porsi 1–1.000.";
const PICKUP_POINT_MSG = "Titik temu tidak valid.";
// Slug opsional: setelah spasi di ujung dibuang, panjangnya 1–100 huruf.
const optionalSlug = (message: string) =>
  z.string({ error: message }).trim().min(1, message).max(100, message).optional();

/**
 * Aturan body rekomendasi. `question` wajib, 3–500 huruf setelah spasi di ujung dibuang. Angka harus berupa angka
 * JSON, bukan teks: `budget` bilangan bulat Rp 1.000–100.000.000, `portions` 1–1.000, `pickup_point_id` ≥ 1.
 * `category` dan `merchant` berisi slug.
 */
export const recommendationSchema = z.object({
  question: z.string({ error: QUESTION_MSG }).trim().min(3, QUESTION_MSG).max(500, QUESTION_MSG),
  budget: z.number({ error: BUDGET_MSG }).int(BUDGET_MSG).min(1000, BUDGET_MSG).max(100_000_000, BUDGET_MSG).optional(),
  portions: z.number({ error: PORTIONS_MSG }).int(PORTIONS_MSG).min(1, PORTIONS_MSG).max(1000, PORTIONS_MSG).optional(),
  category: optionalSlug("Kategori tidak valid."),
  merchant: optionalSlug("Toko tidak valid."),
  pickup_point_id: z.number({ error: PICKUP_POINT_MSG }).int(PICKUP_POINT_MSG).min(1, PICKUP_POINT_MSG).optional(),
});

/** Body rekomendasi yang sudah lolos {@link recommendationSchema}. */
export type RecommendationInput = z.infer<typeof recommendationSchema>;
