// Isi file: skema zod (aturan bentuk data) untuk permintaan alamat unggah foto dan untuk kolom URL foto yang disimpan.
// Dipakai routes (validate) sebelum handler memanggil upload.service, dan oleh skema DTO lain (auth, merchant, menu).
import { z } from "zod";

const MAX_SIZE_MSG = "Ukuran foto maksimal 5 MB.";

/**
 * Isi permintaan alamat unggah foto: tipe gambar (JPG, PNG, atau WebP) dan ukuran file dalam byte (1 byte sampai
 * 5 MB). Pesan galatnya sama dengan komponen unggah di web, supaya pengguna melihat kalimat yang sama.
 */
export const uploadSchema = z.object({
  content_type: z.enum(["image/jpeg", "image/png", "image/webp"], { error: "Format foto harus JPG, PNG, atau WebP." }),
  size: z
    .number({ error: "Ukuran foto tidak valid." })
    .int("Ukuran foto tidak valid.")
    .min(1, "Ukuran foto tidak valid.")
    .max(5_242_880, MAX_SIZE_MSG),
});
/** Unggah foto oleh penjual: {@link uploadSchema} ditambah jenis foto (`menu`, `logo`, `banner`, atau `cover`). */
export const merchantUploadSchema = uploadSchema.extend({
  purpose: z.enum(["menu", "logo", "banner", "cover"], { error: "Jenis foto tidak dikenal." }),
});
/**
 * Unggah gambar platform oleh admin: {@link uploadSchema} ditambah jenis gambar (`banner` atau `popup`). File disimpan
 * di folder `platform/<purpose>/`.
 */
export const adminUploadSchema = uploadSchema.extend({
  purpose: z.enum(["banner", "popup"], { error: "Jenis foto tidak dikenal." }),
});

/**
 * Kolom URL foto yang disimpan (contoh `logo_url`, `avatar_url`): teks paling panjang 500 karakter, `null`, atau tidak
 * dikirim. Teks kosong `""` diubah menjadi `null`, artinya foto dikosongkan. Skema ini hanya memeriksa bentuk; apakah
 * foto itu benar unggahan milik pengguna diperiksa validateImageUrl di upload.service.
 */
export const imageUrlSchema = z.preprocess(
  (value) => (value === "" ? null : value),
  z
    .string({ error: "Foto tidak valid. Unggah ulang foto." })
    .max(500, "Foto tidak valid. Unggah ulang foto.")
    .nullable()
    .optional(),
);
