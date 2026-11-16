import { z } from "zod";

// Banner beranda (rancangan voucher 2026-11-16 §5.4)
const JUDUL = "Judul 3–80 karakter.";
const GAMBAR = "Unggah gambar banner.";
const waktu = (pesan: string) => z.iso.datetime({ offset: true, error: pesan });
const isi = {
  title: z.string({ error: JUDUL }).trim().min(3, JUDUL).max(80, JUDUL),
  image_url: z.string({ error: GAMBAR }).trim().min(1, GAMBAR).max(500, GAMBAR),
  starts_at: waktu("Waktu mulai wajib diisi."),
  ends_at: waktu("Waktu selesai wajib diisi."),
};
const periode = <T extends { starts_at?: string; ends_at?: string }>(d: T, ctx: z.RefinementCtx) => {
  if (d.starts_at && d.ends_at && Date.parse(d.ends_at) <= Date.parse(d.starts_at)) {
    ctx.addIssue({ code: "custom", path: ["ends_at"], message: "Waktu selesai harus setelah waktu mulai." });
  }
  if (d.ends_at && Date.parse(d.ends_at) <= Date.now()) ctx.addIssue({ code: "custom", path: ["ends_at"], message: "Waktu selesai sudah lewat." });
};

// Penjual: tujuan halaman tokonya sendiri atau voucher tokonya
export const bannerTokoSchema = z.object({
  ...isi,
  target: z.enum(["merchant", "promo"], { error: "Pilih tujuan banner." }),
  promo_id: z.number({ error: "Pilih voucher milik tokomu." }).int().positive().nullish(),
}).superRefine(periode);
export const ubahBannerTokoSchema = z.object({
  title: isi.title.optional(), image_url: isi.image_url.optional(), starts_at: isi.starts_at.optional(), ends_at: isi.ends_at.optional(),
  target: z.enum(["merchant", "promo"], { error: "Pilih tujuan banner." }).optional(),
  promo_id: z.number({ error: "Pilih voucher milik tokomu." }).int().positive().nullish(),
}).superRefine(periode);

// Admin: banner platform (langsung tayang); tujuan voucher mana pun atau tanpa tujuan
export const bannerAdminSchema = z.object({
  ...isi,
  target: z.enum(["promo", "none"], { error: "Pilih tujuan banner." }),
  promo_id: z.number({ error: "Pilih voucher." }).int().positive().nullish(),
  sort_order: z.number({ error: "Urutan harus angka." }).int().min(0).max(999).default(0),
}).superRefine(periode);

const ALASAN = "Tulis alasan penolakan (3–300 karakter).";
export const tinjauBannerSchema = z.object({
  status: z.enum(["disetujui", "ditolak", "nonaktif"], { error: "Status tidak dikenal." }).optional(),
  catatan: z.string().trim().max(300, ALASAN).optional().transform((s) => s || undefined),
  sort_order: z.number({ error: "Urutan harus angka." }).int().min(0).max(999).optional(),
  title: isi.title.optional(),
  image_url: isi.image_url.optional(),
  starts_at: isi.starts_at.optional(),
  ends_at: isi.ends_at.optional(),
}).superRefine((d, ctx) => {
  if (d.status === "ditolak" && (!d.catatan || d.catatan.length < 3)) ctx.addIssue({ code: "custom", path: ["catatan"], message: ALASAN });
});

export const daftarBannerSchema = z.object({
  status: z.preprocess((v) => (v === "" ? undefined : v), z.enum(["menunggu", "disetujui", "ditolak", "nonaktif"], { error: "Status tidak dikenal." }).optional()),
});

export type BannerToko = z.infer<typeof bannerTokoSchema>;
export type UbahBannerToko = z.infer<typeof ubahBannerTokoSchema>;
export type BannerAdmin = z.infer<typeof bannerAdminSchema>;
export type TinjauBanner = z.infer<typeof tinjauBannerSchema>;
