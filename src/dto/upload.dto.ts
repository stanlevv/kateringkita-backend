import { z } from "zod";

const UKURAN = "Ukuran foto maksimal 5 MB.";

// Pesan sama dengan FileDrop web (D12)
export const uploadSchema = z.object({
  content_type: z.enum(["image/jpeg", "image/png", "image/webp"], { error: "Format foto harus JPG, PNG, atau WebP." }),
  size: z.number({ error: "Ukuran foto tidak valid." }).int("Ukuran foto tidak valid.").min(1, "Ukuran foto tidak valid.").max(5_242_880, UKURAN),
});
export const merchantUploadSchema = uploadSchema.extend({
  purpose: z.enum(["menu", "logo"], { error: "Jenis foto tidak dikenal." }),
});

// URL foto tersimpan (logo_url, avatar_url, …): string ≤ 500 atau null ("" = kosongkan); aturan pemilik dicek cekUrlGambar
export const urlFoto = z.preprocess(
  (v) => (v === "" ? null : v),
  z.string({ error: "Foto tidak valid. Unggah ulang foto." }).max(500, "Foto tidak valid. Unggah ulang foto.").nullable().optional(),
);
