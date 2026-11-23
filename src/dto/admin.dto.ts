import { z } from "zod";
import { fullNameSchema, phoneSchema } from "./auth.dto";

export const reasonBody = z.object({
  reason: z
    .string({ error: "Alasan wajib diisi." })
    .trim()
    .min(1, "Alasan wajib diisi.")
    .max(500, "Alasan maksimal 500 karakter."),
});

// F19: hapus satu foto menu (foto utama atau tambahan) tanpa menurunkan menunya
export const hapusFotoSchema = reasonBody.extend({
  url: z.string({ error: "Foto wajib dipilih." }).min(1, "Foto wajib dipilih.").max(500, "Foto tidak valid."),
});

// Broadcast pengumuman admin (tab Info di aplikasi pembeli); panjang = kolom notifications
export const pengumumanSchema = z.object({
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
export type PengumumanInput = z.infer<typeof pengumumanSchema>;

// Kontak CS: nomor WA 08…, atau "" untuk mengosongkan
export const kontakCsSchema = z.object({
  wa_number: z
    .string({ error: "Nomor WA tidak valid." })
    .trim()
    .regex(/^(08\d{8,11})?$/, "Nomor WA harus diawali 08 dan 10–13 digit."),
});

// F27 mode pemeliharaan; pesan "" = pesan bawaan
export const pemeliharaanSchema = z.object({
  aktif: z.boolean({ error: "Pilih nyala atau mati." }),
  pesan: z.string({ error: "Pesan tidak valid." }).trim().max(200, "Pesan maksimal 200 karakter.").default(""),
});

// Fase 1 kelola admin
const adminLevel = z.enum(["super", "ops", "support"], { error: "Pilih tingkat admin." });
export const buatAdminSchema = z.object({ full_name: fullNameSchema, phone: phoneSchema, admin_level: adminLevel });
export const levelAdminSchema = z.object({ admin_level: adminLevel });
