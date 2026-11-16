import { z } from "zod";

// Rubrik AI: daftar & verifikasi manual hasil AI di panel admin
const kosong = (v: unknown) => (v === "" ? undefined : v);

export const daftarHasilAiSchema = z.object({
  status: z.preprocess(kosong, z.enum(["menunggu", "disetujui", "ditolak"], { error: "Status tidak dikenal." }).optional()),
  fitur: z.preprocess(kosong, z.enum(["asisten", "rekomendasi"], { error: "Fitur tidak dikenal." }).optional()),
  page: z.coerce.number().int().min(1).catch(1),
  limit: z.coerce.number().int().min(1).catch(20).transform((n) => Math.min(n, 50)),
});
export type DaftarHasilAi = z.infer<typeof daftarHasilAiSchema>;

const ALASAN = "Tulis alasan penolakan (3–300 karakter).";
export const verifikasiAiSchema = z
  .object({
    status: z.enum(["disetujui", "ditolak"], { error: "Pilih disetujui atau ditolak." }),
    catatan: z.string({ error: "Catatan harus berupa teks." }).trim().max(300, "Catatan maksimal 300 karakter.").optional()
      .transform((s) => s || undefined),
  })
  .superRefine((v, ctx) => {
    if (v.status === "ditolak" && (!v.catatan || v.catatan.length < 3)) ctx.addIssue({ code: "custom", path: ["catatan"], message: ALASAN });
  });
export type VerifikasiAi = z.infer<typeof verifikasiAiSchema>;
