import { z } from "zod";

// Banner beranda (rancangan voucher 2026-11-16 §5.4)
const TITLE_MSG = "Judul 3–80 karakter.";
const IMAGE_MSG = "Unggah gambar banner.";
const dateTimeField = (message: string) => z.iso.datetime({ offset: true, error: message });
const contentFields = {
  title: z.string({ error: TITLE_MSG }).trim().min(3, TITLE_MSG).max(80, TITLE_MSG),
  image_url: z.string({ error: IMAGE_MSG }).trim().min(1, IMAGE_MSG).max(500, IMAGE_MSG),
  starts_at: dateTimeField("Waktu mulai wajib diisi."),
  ends_at: dateTimeField("Waktu selesai wajib diisi."),
};
const validatePeriod = <T extends { starts_at?: string; ends_at?: string }>(values: T, ctx: z.RefinementCtx) => {
  if (values.starts_at && values.ends_at && Date.parse(values.ends_at) <= Date.parse(values.starts_at)) {
    ctx.addIssue({ code: "custom", path: ["ends_at"], message: "Waktu selesai harus setelah waktu mulai." });
  }
  if (values.ends_at && Date.parse(values.ends_at) <= Date.now())
    ctx.addIssue({ code: "custom", path: ["ends_at"], message: "Waktu selesai sudah lewat." });
};

// Penjual: tujuan halaman tokonya sendiri atau voucher tokonya
export const merchantBannerSchema = z
  .object({
    ...contentFields,
    target: z.enum(["merchant", "promo"], { error: "Pilih tujuan banner." }),
    promo_id: z.number({ error: "Pilih voucher milik tokomu." }).int().positive().nullish(),
  })
  .superRefine(validatePeriod);
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

// Admin: banner platform (langsung tayang); tujuan voucher mana pun atau tanpa tujuan
export const adminBannerSchema = z
  .object({
    ...contentFields,
    target: z.enum(["promo", "none"], { error: "Pilih tujuan banner." }),
    promo_id: z.number({ error: "Pilih voucher." }).int().positive().nullish(),
    sort_order: z.number({ error: "Urutan harus angka." }).int().min(0).max(999).default(0),
  })
  .superRefine(validatePeriod);

const REASON_MSG = "Tulis alasan penolakan (3–300 karakter).";
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

export const listBannersSchema = z.object({
  status: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.enum(["menunggu", "disetujui", "ditolak", "nonaktif"], { error: "Status tidak dikenal." }).optional(),
  ),
});

export type MerchantBannerInput = z.infer<typeof merchantBannerSchema>;
export type UpdateMerchantBannerInput = z.infer<typeof updateMerchantBannerSchema>;
export type AdminBannerInput = z.infer<typeof adminBannerSchema>;
export type ReviewBannerInput = z.infer<typeof reviewBannerSchema>;
