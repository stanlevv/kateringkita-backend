// Isi file: skema zod untuk query daftar menu, body tambah/ubah menu, dan body ubah kuota hari ini milik penjual.
// Zod = pustaka pemeriksa bentuk data: nilai yang tidak sesuai aturan ditolak dengan pesan galat per kolom (400).
// Dipakai routes/merchant.ts dan handlers/merchant.handler.ts sebelum memanggil merchant-menu.service.
import { z } from "zod";
import { imageUrlSchema } from "./upload.dto";

// Teks opsional untuk query string pencarian.
const optionalText = z.string({ error: "Pencarian tidak valid." }).optional();

/**
 * Query string GET /merchant/menus: `q` (kata cari di nama menu), `category` (slug kategori), dan `status` (active,
 * low = stok sedikit, sold_out = habis, inactive). Semuanya opsional.
 */
export const menuQuerySchema = z.object({
  q: optionalText,
  category: optionalText,
  status: z.enum(["active", "low", "sold_out", "inactive"], { error: "Status tidak dikenal." }).optional(),
});

/** Filter daftar menu yang sudah lolos {@link menuQuerySchema}. */
export type MenuQuery = z.infer<typeof menuQuerySchema>;

// Pesan galat di file ini sama persis dengan menuFormSchema di fe/lib/schemas.ts, supaya web dan server menampilkan
// kalimat yang sama.
// Teks wajib: spasi di ujung dibuang, minimal 1 huruf, maksimal `max` huruf.
const requiredText = (message: string, max: number) =>
  z.string({ error: message }).trim().min(1, message).max(max, `Maksimal ${max} karakter.`);
// Angka bulat dari `min` sampai `max`, dengan pesan galat yang memakai nama kolom `label`.
const numberField = (label: string, min: number, max: number) =>
  z
    .number({ error: `${label} wajib diisi.` })
    .int(`${label} harus bilangan bulat.`)
    .min(min, `${label} minimal ${min.toLocaleString("id-ID")}.`)
    .max(max, `${label} maksimal ${max.toLocaleString("id-ID")}.`);

// Opsi tambahan menu (contoh "Ekstra sambal"): paling banyak 20, nama 1–60 huruf, tambahan harga Rp0–Rp1.000.000.
// Nama tidak boleh kembar tanpa membedakan huruf besar/kecil; galatnya ditaruh di nama opsi yang kembar.
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

// Aturan dasar tiap kolom menu. Aturan yang melibatkan lebih dari satu kolom (harga jual > HPP, hari pre-order 1–7)
// dicek di service karena harus dibandingkan dengan nilai tersimpan.
const menuFields = {
  name: requiredText("Nama menu wajib diisi.", 80),
  category_id: z
    .number({ error: "Kategori wajib dipilih." })
    .int("Kategori wajib dipilih.")
    .min(1, "Kategori wajib dipilih."),
  description: z.string({ error: "Deskripsi harus berupa teks." }).trim().max(500, "Maksimal 500 karakter.").nullable(),
  image_url: imageUrlSchema,
  // foto tambahan selain foto utama, maksimal 4 dan tidak boleh sama; pemilik foto dicek di service
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

/**
 * Body POST /merchant/menus (menu baru). Semua kolom wajib kecuali deskripsi, foto utama `image_url` (boleh kosong),
 * foto tambahan (bawaan kosong), dan opsi (bawaan kosong). Kolom asing seperti `merchant_id` atau `sold_today` dibuang zod, jadi tidak bisa diisi klien.
 */
export const menuSchema = z.object({
  ...menuFields,
  description: menuFields.description.optional(),
  gallery: menuFields.gallery.default([]),
  options: optionsSchema.default([]),
});
/** Body PATCH /merchant/menus/:id. Semua kolom opsional, ditambah `is_active` untuk mengaktifkan/menonaktifkan menu. */
export const menuPatchSchema = z
  .object(menuFields)
  .partial()
  .extend({ is_active: z.boolean({ error: "Status menu tidak valid." }).optional() });

/** Isi body ubah menu yang sudah lolos {@link menuPatchSchema}. */
export type MenuInput = z.infer<typeof menuPatchSchema>;

/**
 * Body PATCH /merchant/menus/:id/quota. Harus berisi tepat salah satu: `delta` (tambah atau kurangi kuota hari ini,
 * bilangan bulat −10.000 sampai 10.000, bukan 0) atau `quota_today` (kuota hari ini yang baru, 0 sampai 10.000).
 * Bila keduanya dikirim atau keduanya kosong, galatnya tidak terikat ke satu kolom (handler mengirimnya tanpa
 * `fields`).
 */
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

/** Isi body ubah kuota yang sudah lolos {@link quotaSchema}. */
export type QuotaInput = z.infer<typeof quotaSchema>;
