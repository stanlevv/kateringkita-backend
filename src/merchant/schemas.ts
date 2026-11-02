import { z } from "zod";
import { urlFoto } from "../upload/service";

export const statusSchema = z.object({ is_open: z.boolean("Status dapur wajib diisi.") });

// Pesan sama persis dengan fe/lib/schemas.ts & fe/lib/wa-template.ts
export const WA_PLACEHOLDERS = ["kode", "nama", "menu", "total", "titik_temu", "waktu_ambil", "metode_bayar"];

const NOMOR_WA = "Nomor WA harus diawali 08 dan 10–13 digit.";
const wajib = (pesan: string, maks: number) => z.string({ error: pesan }).trim().min(1, pesan).max(maks, `Maksimal ${maks} karakter.`);
const jam = z.string({ error: "Jam harus berformat JJ:MM." }).regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Jam harus berformat JJ:MM.");
const angka = (label: string, min: number, maks: number) =>
  z.number({ error: `${label} wajib diisi.` }).int(`${label} harus bilangan bulat.`)
    .min(min, `${label} minimal ${min.toLocaleString("id-ID")}.`)
    .max(maks, `${label} maksimal ${maks.toLocaleString("id-ID")}.`);

const waTemplate = z.string({ error: "Templat tidak boleh kosong." }).superRefine((t, ctx) => {
  const msg = (m: string) => ctx.addIssue({ code: "custom", message: m });
  if (t.trim() === "") return msg("Templat tidak boleh kosong.");
  if (t.length > 1000) return msg("Templat maksimal 1.000 karakter.");
  const asing = [...new Set((t.match(/\{[^{}\n]+\}/g) ?? []).filter((k) => !WA_PLACEHOLDERS.includes(k.slice(1, -1))))];
  if (asing.length > 0) msg(`Kata kunci ${asing.join(", ")} tidak dikenal.`);
});

// Field di luar daftar dibuang zod (mass assignment); logo_url & qris_image_url dicek pemiliknya di service (F04 D10).
export const updateProfileSchema = z.object({
  business_name: wajib("Nama usaha wajib diisi.", 150),
  description: z.string({ error: "Deskripsi harus berupa teks." }).trim().max(500, "Maksimal 500 karakter."),
  address: wajib("Alamat wajib diisi.", 255),
  wa_number: z.string({ error: NOMOR_WA }).regex(/^08\d{8,11}$/, NOMOR_WA),
  service_mode: z.enum(["daily", "event", "both"], { error: "Pilih mode layanan." }),
  open_time: jam,
  close_time: jam,
  hold_minutes: angka("Durasi tahan pesanan", 1, 30),
  daily_revenue_target: angka("Target omzet", 0, 1_000_000_000),
  wa_template: waTemplate,
  logo_url: urlFoto,
  qris_image_url: urlFoto,
  pickup_point_ids: z.array(z.unknown(), { error: "Pilih minimal satu titik temu." })
    .min(1, "Pilih minimal satu titik temu.").max(50, "Maksimal 50 titik temu.")
    // galat per elemen dilaporkan di pickup_point_ids, bukan pickup_point_ids.0
    .refine((a): a is number[] => a.every(Number.isInteger), "Titik temu tidak tersedia."),
}).partial();

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
