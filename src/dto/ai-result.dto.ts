// Isi file: skema zod untuk menu hasil AI di panel admin: query daftar dan isi keputusan pemeriksaan. Nilai status
// (`menunggu`, `disetujui`, `ditolak`), fitur (`asisten`, `rekomendasi`), dan kunci `catatan` adalah kontrak dengan
// database dan web. Dipakai routes/admin.ts dan handlers/ai-result.handler.ts.
import { z } from "zod";

// Teks kosong dari query string dianggap tidak diisi.
const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value);

/**
 * Query daftar hasil AI: `status` dan `fitur` opsional (nilai tidak dikenal = 400); `page` tidak valid dianggap 1;
 * `limit` tidak valid dianggap 20 dan paling banyak 50.
 */
export const listAiResultsSchema = z.object({
  status: z.preprocess(
    emptyToUndefined,
    z.enum(["menunggu", "disetujui", "ditolak"], { error: "Status tidak dikenal." }).optional(),
  ),
  fitur: z.preprocess(
    emptyToUndefined,
    z.enum(["asisten", "rekomendasi"], { error: "Fitur tidak dikenal." }).optional(),
  ),
  page: z.coerce.number().int().min(1).catch(1),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .catch(20)
    .transform((limit) => Math.min(limit, 50)),
});
/** Bentuk query daftar hasil AI yang sudah lolos listAiResultsSchema. */
export type ListAiResultsQuery = z.infer<typeof listAiResultsSchema>;

const REJECT_REASON_MSG = "Tulis alasan penolakan (3–300 karakter).";
/**
 * Isi keputusan pemeriksaan: `status` `disetujui` atau `ditolak`, dan `catatan` opsional paling banyak 300 karakter
 * (teks kosong dianggap tidak diisi). Bila ditolak, catatan wajib minimal 3 karakter sebagai alasan.
 */
export const verifyAiResultSchema = z
  .object({
    status: z.enum(["disetujui", "ditolak"], { error: "Pilih disetujui atau ditolak." }),
    catatan: z
      .string({ error: "Catatan harus berupa teks." })
      .trim()
      .max(300, "Catatan maksimal 300 karakter.")
      .optional()
      .transform((note) => note || undefined),
  })
  .superRefine((input, context) => {
    if (input.status === "ditolak" && (!input.catatan || input.catatan.length < 3))
      context.addIssue({ code: "custom", path: ["catatan"], message: REJECT_REASON_MSG });
  });
/** Bentuk keputusan yang sudah lolos verifyAiResultSchema. */
export type VerifyAiResultInput = z.infer<typeof verifyAiResultSchema>;
