import { z } from "zod";

// F24: kebutuhan pembeli dalam bahasa bebas + batasan opsional (angka JSON, bukan string)
const KEBUTUHAN = "Ceritakan kebutuhanmu 3–500 karakter.";
const ANGGARAN = "Anggaran Rp 1.000–100.000.000.";
const PORSI = "Jumlah porsi 1–1.000.";
const TITIK = "Titik temu tidak valid.";
const slug = (pesan: string) => z.string({ error: pesan }).trim().min(1, pesan).max(100, pesan).optional();

export const rekomendasiSchema = z.object({
  question: z.string({ error: KEBUTUHAN }).trim().min(3, KEBUTUHAN).max(500, KEBUTUHAN),
  budget: z.number({ error: ANGGARAN }).int(ANGGARAN).min(1000, ANGGARAN).max(100_000_000, ANGGARAN).optional(),
  portions: z.number({ error: PORSI }).int(PORSI).min(1, PORSI).max(1000, PORSI).optional(),
  category: slug("Kategori tidak valid."),
  merchant: slug("Toko tidak valid."),
  pickup_point_id: z.number({ error: TITIK }).int(TITIK).min(1, TITIK).optional(),
});

export type RekomendasiInput = z.infer<typeof rekomendasiSchema>;
