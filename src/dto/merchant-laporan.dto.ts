import { z } from "zod";

// F09 (LP-E1): pesan sama dengan fe/lib/laporan.ts#cekRentang
const MAKS_HARI = 92;
const tanggal = z.iso.date({ error: "Tanggal tidak valid." });
export const jumlahHari = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86400e3) + 1;

export const rentangSchema = z
  .object({ from: tanggal, to: tanggal })
  .refine((r) => r.to >= r.from, { path: ["to"], message: "Tanggal akhir harus setelah tanggal awal." })
  .refine((r) => jumlahHari(r.from, r.to) <= MAKS_HARI, { path: ["to"], message: `Rentang maksimal ${MAKS_HARI} hari.` });
export type Rentang = z.infer<typeof rentangSchema>;

export const tanggalSchema = z.object({ date: tanggal });
