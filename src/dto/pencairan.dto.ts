import { z } from "zod";

// F26 tujuan pencairan: kode → nama tampilan. Daftar dikirim ke web lewat GET /merchant/payouts (tanpa salinan di fe).
export const BANK_PENCAIRAN = {
  bca: "BCA", bri: "BRI", bni: "BNI", mandiri: "Mandiri", bsi: "BSI", btn: "BTN", cimb: "CIMB Niaga", permata: "Permata",
  danamon: "Danamon", seabank: "SeaBank", jago: "Bank Jago", dana: "DANA", gopay: "GoPay", ovo: "OVO", shopeepay: "ShopeePay",
} as const;
type KodeBank = keyof typeof BANK_PENCAIRAN;
const KODE_BANK = Object.keys(BANK_PENCAIRAN) as [KodeBank, ...KodeBank[]];
export const namaBank = (kode: string) => BANK_PENCAIRAN[kode as KodeBank] ?? kode;

const REKENING = "Nomor rekening 6–20 angka.";
const PEMILIK = "Nama pemilik rekening 3–100 karakter.";
const REFERENSI = "Nomor referensi transfer 3–100 karakter.";
const referensi = z.string({ error: REFERENSI }).trim().min(3, REFERENSI).max(100, REFERENSI);

// Spasi, titik, dan strip pemisah dibuang ("123-456 789" → "123456789"); kata sandi diminta ulang (dicek di service)
export const rekeningSchema = z.object({
  bank: z.enum(KODE_BANK, { error: "Pilih bank atau e-wallet." }),
  account_number: z.string({ error: REKENING }).transform((s) => s.replace(/[\s.-]/g, "")).pipe(z.string().regex(/^\d{6,20}$/, REKENING)),
  account_name: z.string({ error: PEMILIK }).trim().min(3, PEMILIK).max(100, PEMILIK),
  password: z.string({ error: "Masukkan kata sandi akunmu." }).min(1, "Masukkan kata sandi akunmu."),
}, { error: "Data rekening tidak valid." });

// `until` = as_of dari GET /admin/payouts/balances: hanya pesanan selesai sampai waktu itu yang ikut, dan `amount` harus sama
// dengan jumlahnya. Admin mentransfer dulu, baru mencatat; saldo yang berubah atau catatan ganda ditolak 409.
export const pencairanSchema = z.object({
  merchant_id: z.number({ error: "Penjual tidak valid." }).int("Penjual tidak valid.").min(1, "Penjual tidak valid."),
  amount: z.number({ error: "Nominal tidak valid." }).int("Nominal tidak valid.").min(1, "Nominal tidak valid."),
  until: z.iso.datetime({ offset: true, error: "Waktu saldo tidak valid. Muat ulang halaman." }),
  reference: referensi,
  note: z.string({ error: "Catatan maksimal 255 karakter." }).trim().max(255, "Catatan maksimal 255 karakter.").nullish().transform((s) => s || null),
}, { error: "Data pencairan tidak valid." });

export const refundSchema = z.object({ reference: referensi }, { error: "Data pengembalian dana tidak valid." });

export const halamanSchema = z.object({ page: z.coerce.number().int().min(1).catch(1) });

export type RekeningInput = z.infer<typeof rekeningSchema>;
export type PencairanInput = z.infer<typeof pencairanSchema>;
export type RefundInput = z.infer<typeof refundSchema>;
