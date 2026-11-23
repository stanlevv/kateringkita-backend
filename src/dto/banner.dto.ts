// Isi file: skema zod untuk banner beranda: pengajuan dan ubahan banner penjual, banner platform buatan admin,
// tinjauan admin, dan query daftar admin. zod = pustaka yang memeriksa bentuk data masuk; data yang tidak lolos dijawab
// 400 beserta pesan per kolom. Dipakai banner.service dan handlers/banner.handler.ts. Nama kunci = kontrak JSON.
import { z } from "zod";

const TITLE_MSG = "Judul 3–80 karakter.";
const IMAGE_MSG = "Unggah gambar banner.";
// Waktu ISO 8601 dengan zona waktu ("Z" atau "+07:00").
const dateTimeField = (message: string) => z.iso.datetime({ offset: true, error: message });
// Isi banner: judul, URL gambar hasil unggahan, dan masa tayang (mulai dan selesai).
const contentFields = {
  title: z.string({ error: TITLE_MSG }).trim().min(3, TITLE_MSG).max(80, TITLE_MSG),
  image_url: z.string({ error: IMAGE_MSG }).trim().min(1, IMAGE_MSG).max(500, IMAGE_MSG),
  starts_at: dateTimeField("Waktu mulai wajib diisi."),
  ends_at: dateTimeField("Waktu selesai wajib diisi."),
};
// Masa tayang: waktu selesai harus setelah waktu mulai dan belum lewat.
const validatePeriod = <T extends { starts_at?: string; ends_at?: string }>(values: T, ctx: z.RefinementCtx) => {
  if (values.starts_at && values.ends_at && Date.parse(values.ends_at) <= Date.parse(values.starts_at)) {
    ctx.addIssue({ code: "custom", path: ["ends_at"], message: "Waktu selesai harus setelah waktu mulai." });
  }
  if (values.ends_at && Date.parse(values.ends_at) <= Date.now())
    ctx.addIssue({ code: "custom", path: ["ends_at"], message: "Waktu selesai sudah lewat." });
};

/**
 * Isi `POST /merchant/banners`: isi banner ditambah `target` (`merchant` = halaman tokonya sendiri, `promo` = salah
 * satu voucher tokonya, dengan `promo_id`).
 */
export const merchantBannerSchema = z
  .object({
    ...contentFields,
    target: z.enum(["merchant", "promo"], { error: "Pilih tujuan banner." }),
    promo_id: z.number({ error: "Pilih voucher milik tokomu." }).int().positive().nullish(),
  })
  .superRefine(validatePeriod);
/** Isi `PATCH /merchant/banners/:id`: kolom yang sama dengan pengajuan, semuanya opsional. */
export const updateMerchantBannerSchema = z
  .object({
    title: contentFields.title.optional(),
    image_url: contentFields.image_url.optional(),
    starts_at: contentFields.starts_at.optional(),
    ends_at: contentFields.ends_at.optional(),
    target: z.enum(["merchant", "promo"], { error: "Pilih tujuan banner." }).optional(),
    promo_id: z.number({ error: "Pilih voucher milik tokomu." }).int().positive().nullish(),
  })
  .superRefine(validatePeriod);

/**
 * Isi `POST /admin/banners` (banner platform, langsung tayang): isi banner, `target` (`promo` = voucher mana pun dengan
 * `promo_id`, `none` = tanpa tujuan), dan `sort_order` (urutan tampil 0–999, bawaan 0).
 */
export const adminBannerSchema = z
  .object({
    ...contentFields,
    target: z.enum(["promo", "none"], { error: "Pilih tujuan banner." }),
    promo_id: z.number({ error: "Pilih voucher." }).int().positive().nullish(),
    sort_order: z.number({ error: "Urutan harus angka." }).int().min(0).max(999).default(0),
  })
  .superRefine(validatePeriod);

const REASON_MSG = "Tulis alasan penolakan (3–300 karakter).";
/**
 * Isi `PATCH /admin/banners/:id` (tinjauan admin), semuanya opsional: `status` (`disetujui`, `ditolak`, `nonaktif`),
 * `catatan` (alasan; wajib 3–300 karakter bila ditolak), `sort_order`, serta judul, gambar, dan masa tayang (hanya
 * dipakai untuk banner platform).
 */
export const reviewBannerSchema = z
  .object({
    status: z.enum(["disetujui", "ditolak", "nonaktif"], { error: "Status tidak dikenal." }).optional(),
    catatan: z
      .string()
      .trim()
      .max(300, REASON_MSG)
      .optional()
      .transform((note) => note || undefined),
    sort_order: z.number({ error: "Urutan harus angka." }).int().min(0).max(999).optional(),
    title: contentFields.title.optional(),
    image_url: contentFields.image_url.optional(),
    starts_at: contentFields.starts_at.optional(),
    ends_at: contentFields.ends_at.optional(),
  })
  .superRefine((values, ctx) => {
    if (values.status === "ditolak" && (!values.catatan || values.catatan.length < 3))
      ctx.addIssue({ code: "custom", path: ["catatan"], message: REASON_MSG });
  });

/** Query `GET /admin/banners`: `status` opsional; kosong = semua status. */
export const listBannersSchema = z.object({
  status: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.enum(["menunggu", "disetujui", "ditolak", "nonaktif"], { error: "Status tidak dikenal." }).optional(),
  ),
});

/** Pengajuan banner penjual yang sudah lolos {@link merchantBannerSchema}. */
export type MerchantBannerInput = z.infer<typeof merchantBannerSchema>;
/** Ubahan banner penjual yang sudah lolos {@link updateMerchantBannerSchema}. */
export type UpdateMerchantBannerInput = z.infer<typeof updateMerchantBannerSchema>;
/** Banner platform yang sudah lolos {@link adminBannerSchema}. */
export type AdminBannerInput = z.infer<typeof adminBannerSchema>;
/** Tinjauan admin yang sudah lolos {@link reviewBannerSchema}. */
export type ReviewBannerInput = z.infer<typeof reviewBannerSchema>;
