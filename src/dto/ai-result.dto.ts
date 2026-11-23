import { z } from "zod";

// Rubrik AI: daftar & verifikasi manual hasil AI di panel admin
const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value);

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
export type ListAiResultsQuery = z.infer<typeof listAiResultsSchema>;

const REJECT_REASON_MSG = "Tulis alasan penolakan (3–300 karakter).";
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
export type VerifyAiResultInput = z.infer<typeof verifyAiResultSchema>;
