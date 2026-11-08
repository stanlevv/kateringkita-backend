import { z } from "zod";
import { hariIniWib } from "../merchant/kuota";

// F09 D9 (M-09): query laporan; pesan sama persis dengan fe/lib/laporan.ts#cekRentang
const MAKS_HARI = 92;
const tanggal = z.iso.date({ error: "Tanggal tidak valid." });
// superRefine tetap jalan walau format satu field gagal; field itu sudah punya pesannya sendiri
const sah = (...d: string[]) => d.every((x) => tanggal.safeParse(x).success);
const hariKe = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86400e3;

// YYYY-MM-DD terurut leksikal, jadi `d > hariIniWib()` cukup
const cekTidakLewat = (ctx: z.RefinementCtx, field: string, d: string) => {
  if (sah(d) && d > hariIniWib()) ctx.addIssue({ code: "custom", path: [field], message: "Tanggal tidak boleh melewati hari ini." });
};

export const rentangSchema = z.object({ from: tanggal, to: tanggal }).superRefine((r, ctx) => {
  if (!sah(r.from, r.to)) return;
  if (r.to < r.from) return ctx.addIssue({ code: "custom", path: ["to"], message: "Tanggal akhir harus setelah tanggal awal." });
  cekTidakLewat(ctx, "from", r.from);
  cekTidakLewat(ctx, "to", r.to);
  if (hariKe(r.to) - hariKe(r.from) + 1 > MAKS_HARI) {
    ctx.addIssue({ code: "custom", path: ["to"], message: `Rentang maksimal ${MAKS_HARI} hari.` });
  }
});
export type Rentang = z.infer<typeof rentangSchema>;

export const tanggalSchema = z.object({ date: tanggal }).superRefine((r, ctx) => cekTidakLewat(ctx, "date", r.date));

