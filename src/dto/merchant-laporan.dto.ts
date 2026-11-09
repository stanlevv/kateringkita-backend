import { z } from "zod";
import { hariIniWib } from "../services/merchant-kuota.service";

// F09 (LP-E1): pesan sama dengan fe/lib/laporan.ts#cekRentang
const MAKS_HARI = 92;
const tanggal = z.iso.date({ error: "Tanggal tidak valid." });
export const jumlahHari = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86400e3) + 1;
// superRefine tetap jalan walau format satu field gagal; field itu sudah punya pesannya sendiri
const sah = (...d: string[]) => d.every((x) => tanggal.safeParse(x).success);

// YYYY-MM-DD terurut leksikal, jadi `d > hariIniWib()` cukup
const cekTidakLewat = (ctx: z.RefinementCtx, field: string, d: string) => {
  if (sah(d) && d > hariIniWib()) ctx.addIssue({ code: "custom", path: [field], message: "Tanggal tidak boleh melewati hari ini." });
};

export const rentangSchema = z.object({ from: tanggal, to: tanggal }).superRefine((r, ctx) => {
  if (!sah(r.from, r.to)) return;
  if (r.to < r.from) return ctx.addIssue({ code: "custom", path: ["to"], message: "Tanggal akhir harus setelah tanggal awal." });
  cekTidakLewat(ctx, "from", r.from);
  cekTidakLewat(ctx, "to", r.to);
  if (jumlahHari(r.from, r.to) > MAKS_HARI) ctx.addIssue({ code: "custom", path: ["to"], message: `Rentang maksimal ${MAKS_HARI} hari.` });
});
export type Rentang = z.infer<typeof rentangSchema>;

export const tanggalSchema = z.object({ date: tanggal }).superRefine((r, ctx) => cekTidakLewat(ctx, "date", r.date));
