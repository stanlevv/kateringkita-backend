import { z } from "zod";

// Pop-up promo mobile (rancangan voucher 2026-11-16 §5.5)
const TITLE_MSG = "Judul 3–80 karakter.";
const IMAGE_MSG = "Unggah gambar pop-up.";
const dateTimeField = (message: string) => z.iso.datetime({ offset: true, error: message });
const validatePeriod = (values: { starts_at?: string; ends_at?: string }, ctx: z.RefinementCtx) => {
  if (values.starts_at && values.ends_at && Date.parse(values.ends_at) <= Date.parse(values.starts_at)) {
    ctx.addIssue({ code: "custom", path: ["ends_at"], message: "Waktu selesai harus setelah waktu mulai." });
  }
  if (values.ends_at && Date.parse(values.ends_at) <= Date.now())
    ctx.addIssue({ code: "custom", path: ["ends_at"], message: "Waktu selesai sudah lewat." });
};
const popupFields = {
  title: z.string({ error: TITLE_MSG }).trim().min(3, TITLE_MSG).max(80, TITLE_MSG),
  image_url: z.string({ error: IMAGE_MSG }).trim().min(1, IMAGE_MSG).max(500, IMAGE_MSG),
  promo_id: z.number({ error: "Pilih voucher platform." }).int().positive().nullish(),
  starts_at: dateTimeField("Waktu mulai wajib diisi."),
  ends_at: dateTimeField("Waktu selesai wajib diisi."),
  is_active: z.boolean({ error: "Status tidak valid." }),
};

export const popupSchema = z
  .object({ ...popupFields, is_active: popupFields.is_active.default(true) })
  .superRefine(validatePeriod);
export const updatePopupSchema = z
  .object({
    title: popupFields.title.optional(),
    image_url: popupFields.image_url.optional(),
    promo_id: popupFields.promo_id,
    starts_at: popupFields.starts_at.optional(),
    ends_at: popupFields.ends_at.optional(),
    is_active: popupFields.is_active.optional(),
  })
  .superRefine(validatePeriod);

export type PopupInput = z.infer<typeof popupSchema>;
export type UpdatePopupInput = z.infer<typeof updatePopupSchema>;
