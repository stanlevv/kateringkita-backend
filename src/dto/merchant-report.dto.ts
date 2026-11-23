// Isi file: skema zod untuk query laporan penjualan toko (rentang tanggal dan satu tanggal) dan rekap keuangan admin.
// zod = pustaka yang memeriksa bentuk data masuk; data yang tidak lolos dijawab 400 beserta pesan per kolom. Dipakai
// handlers/merchant.handler.ts dan handlers/admin.handler.ts sebelum memanggil service. Nama kunci = kontrak JSON.
import { z } from "zod";
import { getWibDate } from "../services/merchant-quota.service";

// Pesan galat di sini sama dengan pemeriksaan rentang di aplikasi web, supaya penjual melihat kalimat yang sama.
const MAX_RANGE_DAYS = 92;
const dateField = z.iso.date({ error: "Tanggal tidak valid." });
/**
 * Menghitung jumlah hari dalam rentang, kedua ujungnya ikut (1–3 Januari = 3 hari).
 * @param startDate tanggal awal `YYYY-MM-DD`
 * @param endDate   tanggal akhir `YYYY-MM-DD`
 * @returns jumlah hari
 */
export const countDays = (startDate: string, endDate: string) =>
  Math.round((Date.parse(endDate) - Date.parse(startDate)) / 86400e3) + 1;
// superRefine tetap jalan walau format satu field gagal; field itu sudah punya pesannya sendiri
const areValidDates = (...dates: string[]) => dates.every((date) => dateField.safeParse(date).success);

// Teks YYYY-MM-DD bisa dibandingkan langsung sebagai teks, jadi `date > getWibDate()` cukup untuk "lewat hari ini".
const rejectFutureDate = (ctx: z.RefinementCtx, field: string, date: string) => {
  if (areValidDates(date) && date > getWibDate())
    ctx.addIssue({ code: "custom", path: [field], message: "Tanggal tidak boleh melewati hari ini." });
};

// Pembuat skema rentang `{ from, to }`: akhir tidak boleh sebelum awal, paling panjang 92 hari, dan (bila
// `rejectFuture`) tidak boleh melewati hari ini menurut WIB.
const rangeSchema = (rejectFuture: boolean) =>
  z.object({ from: dateField, to: dateField }).superRefine((range, ctx) => {
    if (!areValidDates(range.from, range.to)) return;
    if (range.to < range.from)
      return ctx.addIssue({ code: "custom", path: ["to"], message: "Tanggal akhir harus setelah tanggal awal." });
    if (rejectFuture) {
      rejectFutureDate(ctx, "from", range.from);
      rejectFutureDate(ctx, "to", range.to);
    }
    if (countDays(range.from, range.to) > MAX_RANGE_DAYS)
      ctx.addIssue({ code: "custom", path: ["to"], message: `Rentang maksimal ${MAX_RANGE_DAYS} hari.` });
  });
/** Query `from` dan `to` laporan penjual: tanggal WIB, paling panjang 92 hari, dan tidak boleh melewati hari ini. */
export const reportRangeSchema = rangeSchema(true);
/**
 * Query rentang untuk rekap keuangan admin: aturannya sama, kecuali boleh mencakup hari yang belum lewat (hari itu
 * hasilnya kosong).
 */
export const adminRangeSchema = rangeSchema(false);
/** Rentang tanggal `{ from, to }` yang sudah lolos salah satu skema rentang di atas. */
export type DateRange = z.infer<typeof reportRangeSchema>;

/** Query `date` laporan per jam: satu tanggal WIB yang tidak boleh melewati hari ini. */
export const reportDateSchema = z
  .object({ date: dateField })
  .superRefine((query, ctx) => rejectFutureDate(ctx, "date", query.date));
