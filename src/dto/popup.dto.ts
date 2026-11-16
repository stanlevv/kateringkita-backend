import { z } from "zod";

// Pop-up promo mobile (rancangan voucher 2026-11-16 §5.5)
const JUDUL = "Judul 3–80 karakter.";
const GAMBAR = "Unggah gambar pop-up.";
const waktu = (pesan: string) => z.iso.datetime({ offset: true, error: pesan });
const periode = (d: { starts_at?: string; ends_at?: string }, ctx: z.RefinementCtx) => {
  if (d.starts_at && d.ends_at && Date.parse(d.ends_at) <= Date.parse(d.starts_at)) {
    ctx.addIssue({ code: "custom", path: ["ends_at"], message: "Waktu selesai harus setelah waktu mulai." });
  }
  if (d.ends_at && Date.parse(d.ends_at) <= Date.now()) ctx.addIssue({ code: "custom", path: ["ends_at"], message: "Waktu selesai sudah lewat." });
};
const kolom = {
  title: z.string({ error: JUDUL }).trim().min(3, JUDUL).max(80, JUDUL),
  image_url: z.string({ error: GAMBAR }).trim().min(1, GAMBAR).max(500, GAMBAR),
  promo_id: z.number({ error: "Pilih voucher platform." }).int().positive().nullish(),
  starts_at: waktu("Waktu mulai wajib diisi."),
  ends_at: waktu("Waktu selesai wajib diisi."),
  is_active: z.boolean({ error: "Status tidak valid." }),
};

export const popupSchema = z.object({ ...kolom, is_active: kolom.is_active.default(true) }).superRefine(periode);
export const ubahPopupSchema = z.object({
  title: kolom.title.optional(), image_url: kolom.image_url.optional(), promo_id: kolom.promo_id, starts_at: kolom.starts_at.optional(),
  ends_at: kolom.ends_at.optional(), is_active: kolom.is_active.optional(),
}).superRefine(periode);

export type PopupInput = z.infer<typeof popupSchema>;
export type UbahPopup = z.infer<typeof ubahPopupSchema>;
