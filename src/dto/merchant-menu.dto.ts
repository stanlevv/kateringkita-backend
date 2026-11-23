import { z } from "zod";
import { imageUrlSchema } from "./upload.dto";

const optionalText = z.string({ error: "Pencarian tidak valid." }).optional();

export const menuQuerySchema = z.object({
  q: optionalText,
  category: optionalText,
  status: z.enum(["active", "low", "sold_out", "inactive"], { error: "Status tidak dikenal." }).optional(),
});

export type MenuQuery = z.infer<typeof menuQuerySchema>;

// Pesan sama persis dengan menuFormSchema di fe/lib/schemas.ts (D9)
const requiredText = (message: string, max: number) =>
  z.string({ error: message }).trim().min(1, message).max(max, `Maksimal ${max} karakter.`);
const numberField = (label: string, min: number, max: number) =>
  z
    .number({ error: `${label} wajib diisi.` })
    .int(`${label} harus bilangan bulat.`)
    .min(min, `${label} minimal ${min.toLocaleString("id-ID")}.`)
    .max(max, `${label} maksimal ${max.toLocaleString("id-ID")}.`);

const optionsSchema = z
  .array(
    z.object({
      name: requiredText("Nama opsi wajib diisi.", 60),
      extra_price: numberField("Tambahan harga", 0, 1_000_000),
    }),
    {
      error: "Opsi tidak valid.",
    },
  )
  .max(20, "Maksimal 20 opsi.")
  .superRefine((list, context) => {
    const seenNames = new Set<string>();
    list.forEach((option, i) => {
      const lowerName = option.name.toLowerCase();
      if (seenNames.has(lowerName))
        context.addIssue({ code: "custom", path: [i, "name"], message: "Nama opsi sama dengan opsi lain." });
      seenNames.add(lowerName);
    });
  });

// Aturan antar-field (harga > HPP, hari pre-order) dicek di service dengan nilai tersimpan
const menuFields = {
  name: requiredText("Nama menu wajib diisi.", 80),
  category_id: z
    .number({ error: "Kategori wajib dipilih." })
    .int("Kategori wajib dipilih.")
    .min(1, "Kategori wajib dipilih."),
  description: z.string({ error: "Deskripsi harus berupa teks." }).trim().max(500, "Maksimal 500 karakter.").nullable(),
  image_url: imageUrlSchema,
  // foto tambahan selain foto utama; aturan pemilik dicek service
  gallery: z
    .array(
      z.string({ error: "Foto tidak valid. Unggah ulang foto." }).max(500, "Foto tidak valid. Unggah ulang foto."),
      { error: "Foto tambahan tidak valid." },
    )
    .max(4, "Maksimal 4 foto tambahan.")
    .refine((photos) => new Set(photos).size === photos.length, "Foto tambahan tidak boleh sama."),
  unit_label: requiredText("Satuan wajib diisi.", 30),
  price: numberField("Harga jual", 1000, 100_000_000),
  hpp: numberField("HPP", 0, 100_000_000),
  daily_quota: numberField("Kuota harian", 0, 10_000),
  prep_minutes: numberField("Estimasi siap", 1, 1440),
  is_preorder: z.boolean({ error: "Pilih jenis pesanan." }),
  preorder_days: z.number({ error: "Hari pre-order wajib diisi." }).int("Hari pre-order harus bilangan bulat."),
  min_order_qty: numberField("Minimum pesan", 1, 1000),
  options: optionsSchema,
};

// POST: field asing (merchant_id, sold_today, …) dibuang zod
export const menuSchema = z.object({
  ...menuFields,
  description: menuFields.description.optional(),
  gallery: menuFields.gallery.default([]),
  options: optionsSchema.default([]),
});
// PATCH: semua opsional + is_active (D2)
export const menuPatchSchema = z
  .object(menuFields)
  .partial()
  .extend({ is_active: z.boolean({ error: "Status menu tidak valid." }).optional() });

export type MenuInput = z.infer<typeof menuPatchSchema>;

// D6: tepat salah satu dari delta / quota_today; galat lintas-field tanpa `fields`
export const quotaSchema = z
  .object({
    delta: z
      .number({ error: "Perubahan kuota tidak valid." })
      .int("Perubahan kuota tidak valid.")
      .min(-10_000, "Perubahan kuota tidak valid.")
      .max(10_000, "Perubahan kuota tidak valid.")
      .refine((delta) => delta !== 0, "Perubahan kuota tidak valid.")
      .optional(),
    quota_today: numberField("Kuota hari ini", 0, 10_000).optional(),
  })
  .refine((body) => (body.delta === undefined) !== (body.quota_today === undefined), "Data kuota tidak valid.");

export type QuotaInput = z.infer<typeof quotaSchema>;
