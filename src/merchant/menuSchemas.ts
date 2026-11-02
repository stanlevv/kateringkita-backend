import { z } from "zod";
import { urlFoto } from "../upload/service";

const teks = z.string({ error: "Pencarian tidak valid." }).optional();

export const menuQuerySchema = z.object({
  q: teks,
  category: teks,
  status: z.enum(["active", "low", "sold_out", "inactive"], { error: "Status tidak dikenal." }).optional(),
});

export type MenuQuery = z.infer<typeof menuQuerySchema>;

// Pesan sama persis dengan menuFormSchema di fe/lib/schemas.ts (D9)
const wajib = (pesan: string, maks: number) => z.string({ error: pesan }).trim().min(1, pesan).max(maks, `Maksimal ${maks} karakter.`);
const angka = (label: string, min: number, maks: number) =>
  z.number({ error: `${label} wajib diisi.` }).int(`${label} harus bilangan bulat.`)
    .min(min, `${label} minimal ${min.toLocaleString("id-ID")}.`)
    .max(maks, `${label} maksimal ${maks.toLocaleString("id-ID")}.`);

const opsi = z.array(z.object({ name: wajib("Nama opsi wajib diisi.", 60), extra_price: angka("Tambahan harga", 0, 1_000_000) }), { error: "Opsi tidak valid." })
  .max(20, "Maksimal 20 opsi.")
  .superRefine((list, ctx) => {
    const lihat = new Set<string>();
    list.forEach((o, i) => {
      const k = o.name.toLowerCase();
      if (lihat.has(k)) ctx.addIssue({ code: "custom", path: [i, "name"], message: "Nama opsi sama dengan opsi lain." });
      lihat.add(k);
    });
  });

// Aturan antar-field (harga > HPP, hari pre-order) dicek di service dengan nilai tersimpan
const fields = {
  name: wajib("Nama menu wajib diisi.", 80),
  category_id: z.number({ error: "Kategori wajib dipilih." }).int("Kategori wajib dipilih.").min(1, "Kategori wajib dipilih."),
  description: z.string({ error: "Deskripsi harus berupa teks." }).trim().max(500, "Maksimal 500 karakter.").nullable(),
  image_url: urlFoto,
  unit_label: wajib("Satuan wajib diisi.", 30),
  price: angka("Harga jual", 1000, 100_000_000),
  hpp: angka("HPP", 0, 100_000_000),
  daily_quota: angka("Kuota harian", 0, 10_000),
  prep_minutes: angka("Estimasi siap", 1, 1440),
  is_preorder: z.boolean({ error: "Pilih jenis pesanan." }),
  preorder_days: z.number({ error: "Hari pre-order wajib diisi." }).int("Hari pre-order harus bilangan bulat."),
  min_order_qty: angka("Minimum pesan", 1, 1000),
  options: opsi,
};

// POST: field asing (merchant_id, sold_today, …) dibuang zod
export const menuSchema = z.object({ ...fields, description: fields.description.optional(), options: opsi.default([]) });
// PATCH: semua opsional + is_active (D2)
export const menuPatchSchema = z.object(fields).partial().extend({ is_active: z.boolean({ error: "Status menu tidak valid." }).optional() });

export type MenuInput = z.infer<typeof menuPatchSchema>;

// D6: tepat salah satu dari delta / quota_today; galat lintas-field tanpa `fields`
export const kuotaSchema = z.object({
  delta: z.number({ error: "Perubahan kuota tidak valid." }).int("Perubahan kuota tidak valid.")
    .min(-10_000, "Perubahan kuota tidak valid.").max(10_000, "Perubahan kuota tidak valid.")
    .refine((d) => d !== 0, "Perubahan kuota tidak valid.").optional(),
  quota_today: angka("Kuota hari ini", 0, 10_000).optional(),
}).refine((b) => (b.delta === undefined) !== (b.quota_today === undefined), "Data kuota tidak valid.");

export type KuotaInput = z.infer<typeof kuotaSchema>;
