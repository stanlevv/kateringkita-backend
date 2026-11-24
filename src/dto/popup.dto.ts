// Isi file: skema zod untuk membuat dan mengubah pop-up promo aplikasi mobile (khusus admin). zod = pustaka yang
// memeriksa bentuk data masuk; data yang tidak lolos dijawab 400 beserta pesan per kolom. Dipakai popup.service.
// Nama kunci di sini adalah kontrak JSON.
import { z } from "zod";

const TITLE_MSG = "Judul 3–80 karakter.";
const IMAGE_MSG = "Unggah gambar pop-up.";
// Waktu ISO 8601 dengan zona waktu ("Z" atau "+07:00").
const dateTimeField = (message: string) => z.iso.datetime({ offset: true, error: message });
// Masa tayang: waktu selesai harus setelah waktu mulai dan belum lewat.
const validatePeriod = (values: { starts_at?: string; ends_at?: string }, ctx: z.RefinementCtx) => {
  if (values.starts_at && values.ends_at && Date.parse(values.ends_at) <= Date.parse(values.starts_at)) {
    ctx.addIssue({ code: "custom", path: ["ends_at"], message: "Waktu selesai harus setelah waktu mulai." });
  }
  if (values.ends_at && Date.parse(values.ends_at) <= Date.now())
    ctx.addIssue({ code: "custom", path: ["ends_at"], message: "Waktu selesai sudah lewat." });
};
// Kolom pop-up: judul, gambar hasil unggahan, voucher platform opsional, masa tayang, dan status aktif.
const popupFields = {
  title: z.string({ error: TITLE_MSG }).trim().min(3, TITLE_MSG).max(80, TITLE_MSG),
  image_url: z.string({ error: IMAGE_MSG }).trim().min(1, IMAGE_MSG).max(500, IMAGE_MSG),
  promo_id: z.number({ error: "Pilih voucher platform." }).int().positive().nullish(),
  starts_at: dateTimeField("Waktu mulai wajib diisi."),
  ends_at: dateTimeField("Waktu selesai wajib diisi."),
  is_active: z.boolean({ error: "Status tidak valid." }),
};

/** Isi `POST /admin/popups`: semua kolom pop-up; `promo_id` opsional, `is_active` bawaan true. */
export const popupSchema = z
  .object({ ...popupFields, is_active: popupFields.is_active.default(true) })
  .superRefine(validatePeriod);
/** Isi `PATCH /admin/popups/:id`: kolom yang sama, semuanya opsional; `promo_id: null` melepas voucher. */
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

/** Pop-up baru yang sudah lolos {@link popupSchema}. */
export type PopupInput = z.infer<typeof popupSchema>;
/** Ubahan pop-up yang sudah lolos {@link updatePopupSchema}. */
export type UpdatePopupInput = z.infer<typeof updatePopupSchema>;
