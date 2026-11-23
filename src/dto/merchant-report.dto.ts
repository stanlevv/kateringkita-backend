import { z } from "zod";
import { getWibDate } from "../services/merchant-quota.service";

// F09 (LP-E1): pesan sama dengan fe/lib/laporan.ts#cekRentang
const MAX_RANGE_DAYS = 92;
const dateField = z.iso.date({ error: "Tanggal tidak valid." });
export const countDays = (startDate: string, endDate: string) =>
  Math.round((Date.parse(endDate) - Date.parse(startDate)) / 86400e3) + 1;
// superRefine tetap jalan walau format satu field gagal; field itu sudah punya pesannya sendiri
const areValidDates = (...dates: string[]) => dates.every((date) => dateField.safeParse(date).success);

// YYYY-MM-DD terurut leksikal, jadi `d > getWibDate()` cukup
const rejectFutureDate = (ctx: z.RefinementCtx, field: string, date: string) => {
  if (areValidDates(date) && date > getWibDate())
    ctx.addIssue({ code: "custom", path: [field], message: "Tanggal tidak boleh melewati hari ini." });
};

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
export const reportRangeSchema = rangeSchema(true);
// F20: rekap keuangan admin menerima rentang yang mencakup hari depan (hasilnya kosong), sesuai uji F20
export const adminRangeSchema = rangeSchema(false);
export type DateRange = z.infer<typeof reportRangeSchema>;

export const reportDateSchema = z
  .object({ date: dateField })
  .superRefine((query, ctx) => rejectFutureDate(ctx, "date", query.date));
