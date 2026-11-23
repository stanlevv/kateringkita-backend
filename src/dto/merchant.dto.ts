import { z } from "zod";
import { imageUrlSchema } from "./upload.dto";

export const openStatusSchema = z.object({ is_open: z.boolean("Status dapur wajib diisi.") });

// Pesan sama persis dengan fe/lib/schemas.ts & fe/lib/wa-template.ts
export const WA_PLACEHOLDERS = ["kode", "nama", "menu", "total", "titik_temu", "waktu_ambil", "metode_bayar"];

const WA_NUMBER_MSG = "Nomor WA harus diawali 08 dan 10–13 digit.";
const requiredText = (message: string, max: number) =>
  z.string({ error: message }).trim().min(1, message).max(max, `Maksimal ${max} karakter.`);
const timeSchema = z
  .string({ error: "Jam harus berformat JJ:MM." })
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Jam harus berformat JJ:MM.");
const numberField = (label: string, min: number, max: number) =>
  z
    .number({ error: `${label} wajib diisi.` })
    .int(`${label} harus bilangan bulat.`)
    .min(min, `${label} minimal ${min.toLocaleString("id-ID")}.`)
    .max(max, `${label} maksimal ${max.toLocaleString("id-ID")}.`);

const waTemplateSchema = z.string({ error: "Templat tidak boleh kosong." }).superRefine((template, context) => {
  const reportIssue = (message: string) => context.addIssue({ code: "custom", message: message });
  if (template.trim() === "") return reportIssue("Templat tidak boleh kosong.");
  if (template.length > 1000) return reportIssue("Templat maksimal 1.000 karakter.");
  const unknownKeys = [
    ...new Set(
      (template.match(/\{[^{}\n]+\}/g) ?? []).filter(
        (placeholder) => !WA_PLACEHOLDERS.includes(placeholder.slice(1, -1)),
      ),
    ),
  ];
  if (unknownKeys.length > 0) reportIssue(`Kata kunci ${unknownKeys.join(", ")} tidak dikenal.`);
});

// Field di luar daftar dibuang zod (mass assignment); logo_url dicek pemiliknya di service (F04 D10).
// F26: qris_image_url dihapus (semua non-tunai lewat Midtrans); rekening pencairan lewat PUT /merchant/payout-account.
export const updateProfileSchema = z
  .object({
    business_name: requiredText("Nama usaha wajib diisi.", 150),
    description: z.string({ error: "Deskripsi harus berupa teks." }).trim().max(500, "Maksimal 500 karakter."),
    address: requiredText("Alamat wajib diisi.", 255),
    wa_number: z.string({ error: WA_NUMBER_MSG }).regex(/^08\d{8,11}$/, WA_NUMBER_MSG),
    service_mode: z.enum(["daily", "event", "both"], { error: "Pilih mode layanan." }),
    open_time: timeSchema,
    close_time: timeSchema,
    hold_minutes: numberField("Durasi tahan pesanan", 1, 30),
    daily_revenue_target: numberField("Target omzet", 0, 1_000_000_000),
    wa_template: waTemplateSchema,
    logo_url: imageUrlSchema,
    // background profil toko (unggahan purpose cover)
    cover_url: imageUrlSchema,
    // F21: terima pesanan dari meja (QR)
    dine_in_enabled: z.boolean({ error: "Pilihan pesan dari meja tidak valid." }),
    pickup_point_ids: z
      .array(z.unknown(), { error: "Pilih minimal satu titik temu." })
      .min(1, "Pilih minimal satu titik temu.")
      .max(50, "Maksimal 50 titik temu.")
      // galat per elemen dilaporkan di pickup_point_ids, bukan pickup_point_ids.0
      .refine((ids): ids is number[] => ids.every(Number.isInteger), "Titik temu tidak tersedia."),
  })
  .partial();

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
