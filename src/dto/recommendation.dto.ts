import { z } from "zod";

// F24: kebutuhan pembeli dalam bahasa bebas + batasan opsional (angka JSON, bukan string)
const QUESTION_MSG = "Ceritakan kebutuhanmu 3–500 karakter.";
const BUDGET_MSG = "Anggaran Rp 1.000–100.000.000.";
const PORTIONS_MSG = "Jumlah porsi 1–1.000.";
const PICKUP_POINT_MSG = "Titik temu tidak valid.";
const optionalSlug = (message: string) =>
  z.string({ error: message }).trim().min(1, message).max(100, message).optional();

export const recommendationSchema = z.object({
  question: z.string({ error: QUESTION_MSG }).trim().min(3, QUESTION_MSG).max(500, QUESTION_MSG),
  budget: z.number({ error: BUDGET_MSG }).int(BUDGET_MSG).min(1000, BUDGET_MSG).max(100_000_000, BUDGET_MSG).optional(),
  portions: z.number({ error: PORTIONS_MSG }).int(PORTIONS_MSG).min(1, PORTIONS_MSG).max(1000, PORTIONS_MSG).optional(),
  category: optionalSlug("Kategori tidak valid."),
  merchant: optionalSlug("Toko tidak valid."),
  pickup_point_id: z.number({ error: PICKUP_POINT_MSG }).int(PICKUP_POINT_MSG).min(1, PICKUP_POINT_MSG).optional(),
});

export type RecommendationInput = z.infer<typeof recommendationSchema>;
