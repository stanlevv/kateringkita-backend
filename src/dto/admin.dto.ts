// Isi file: skema zod untuk isi permintaan panel admin: alasan aksi, hapus foto menu, pengumuman, kontak CS, mode
// pemeliharaan, dan kelola akun admin. zod = pustaka yang memeriksa bentuk data masuk; data yang tidak lolos
// dijawab 400 beserta pesan per kolom. Dipasang lewat validate(...) di routes/admin.ts sebelum handler. Nama kunci di
// sini adalah kontrak JSON.
import { z } from "zod";
import { fullNameSchema, phoneSchema } from "./auth.dto";

/**
 * Isi `{ reason }` untuk aksi admin yang wajib beralasan (minta perbaikan, tangguhkan toko, sembunyikan ulasan,
 * turunkan menu): 1–500 karakter setelah spasi di ujung dibuang.
 */
export const adminReasonSchema = z.object({
  reason: z
    .string({ error: "Alasan wajib diisi." })
    .trim()
    .min(1, "Alasan wajib diisi.")
    .max(500, "Alasan maksimal 500 karakter."),
});

/** Isi hapus satu foto menu: `reason` seperti di atas dan `url` foto yang dihapus (foto utama atau tambahan). */
export const removePhotoSchema = adminReasonSchema.extend({
  url: z.string({ error: "Foto wajib dipilih." }).min(1, "Foto wajib dipilih.").max(500, "Foto tidak valid."),
});

/**
 * Isi pengumuman admin (tab Info di aplikasi): sasaran `all`/`customer`/`merchant`, judul 1–120 karakter, dan isi
 * 1–255 karakter (panjang mengikuti kolom tabel notifications).
 */
export const announcementSchema = z.object({
  audience: z.enum(["all", "customer", "merchant"], { error: "Pilih penerima pengumuman." }),
  title: z
    .string({ error: "Judul wajib diisi." })
    .trim()
    .min(1, "Judul wajib diisi.")
    .max(120, "Judul maksimal 120 karakter."),
  body: z
    .string({ error: "Isi wajib diisi." })
    .trim()
    .min(1, "Isi wajib diisi.")
    .max(255, "Isi maksimal 255 karakter."),
});
/** Bentuk pengumuman yang sudah lolos announcementSchema. */
export type AnnouncementInput = z.infer<typeof announcementSchema>;

/** Isi kontak CS: `wa_number` berupa nomor WA 08… (10–13 digit), atau teks kosong untuk mengosongkan. */
export const csContactSchema = z.object({
  wa_number: z
    .string({ error: "Nomor WA tidak valid." })
    .trim()
    .regex(/^(08\d{8,11})?$/, "Nomor WA harus diawali 08 dan 10–13 digit."),
});

/**
 * Isi mode pemeliharaan: `aktif` menyalakan atau mematikan, `pesan` paling banyak 200 karakter (kosong = pesan bawaan).
 */
export const maintenanceSchema = z.object({
  aktif: z.boolean({ error: "Pilih nyala atau mati." }),
  pesan: z.string({ error: "Pesan tidak valid." }).trim().max(200, "Pesan maksimal 200 karakter.").default(""),
});

// Tingkat admin yang boleh dipilih.
const adminLevelSchema = z.enum(["super", "ops", "support"], { error: "Pilih tingkat admin." });
/** Isi membuat admin baru: nama lengkap, nomor HP (aturan sama dengan pendaftaran), dan tingkat admin. */
export const createAdminSchema = z.object({
  full_name: fullNameSchema,
  phone: phoneSchema,
  admin_level: adminLevelSchema,
});
/** Isi mengubah tingkat admin: `{ admin_level }`. */
export const updateAdminLevelSchema = z.object({ admin_level: adminLevelSchema });
