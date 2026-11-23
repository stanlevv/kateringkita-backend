import { z } from "zod";

// F26 tujuan pencairan: kode → nama tampilan. Daftar dikirim ke web lewat GET /merchant/payouts (tanpa salinan di fe).
export const PAYOUT_BANKS = {
  bca: "BCA",
  bri: "BRI",
  bni: "BNI",
  mandiri: "Mandiri",
  bsi: "BSI",
  btn: "BTN",
  cimb: "CIMB Niaga",
  permata: "Permata",
  danamon: "Danamon",
  seabank: "SeaBank",
  jago: "Bank Jago",
  dana: "DANA",
  gopay: "GoPay",
  ovo: "OVO",
  shopeepay: "ShopeePay",
} as const;
type BankCode = keyof typeof PAYOUT_BANKS;
const BANK_CODES = Object.keys(PAYOUT_BANKS) as [BankCode, ...BankCode[]];
export const getBankName = (code: string) => PAYOUT_BANKS[code as BankCode] ?? code;

const ACCOUNT_NUMBER_MSG = "Nomor rekening 6–20 angka.";
const ACCOUNT_NAME_MSG = "Nama pemilik rekening 3–100 karakter.";
const REFERENCE_MSG = "Nomor referensi transfer 3–100 karakter.";
const referenceField = z.string({ error: REFERENCE_MSG }).trim().min(3, REFERENCE_MSG).max(100, REFERENCE_MSG);

// Spasi, titik, dan strip pemisah dibuang ("123-456 789" → "123456789"); kata sandi diminta ulang (dicek di service)
export const bankAccountSchema = z.object(
  {
    bank: z.enum(BANK_CODES, { error: "Pilih bank atau e-wallet." }),
    account_number: z
      .string({ error: ACCOUNT_NUMBER_MSG })
      .transform((text) => text.replace(/[\s.-]/g, ""))
      .pipe(z.string().regex(/^\d{6,20}$/, ACCOUNT_NUMBER_MSG)),
    account_name: z.string({ error: ACCOUNT_NAME_MSG }).trim().min(3, ACCOUNT_NAME_MSG).max(100, ACCOUNT_NAME_MSG),
    password: z.string({ error: "Masukkan kata sandi akunmu." }).min(1, "Masukkan kata sandi akunmu."),
  },
  { error: "Data rekening tidak valid." },
);

// `until` = as_of dari GET /admin/payouts/balances: hanya pesanan selesai sampai waktu itu yang ikut, dan `amount` harus sama
// dengan jumlahnya. Admin mentransfer dulu, baru mencatat; saldo yang berubah atau catatan ganda ditolak 409.
export const payoutSchema = z.object(
  {
    merchant_id: z.number({ error: "Penjual tidak valid." }).int("Penjual tidak valid.").min(1, "Penjual tidak valid."),
    amount: z.number({ error: "Nominal tidak valid." }).int("Nominal tidak valid.").min(1, "Nominal tidak valid."),
    until: z.iso.datetime({ offset: true, error: "Waktu saldo tidak valid. Muat ulang halaman." }),
    reference: referenceField,
    note: z
      .string({ error: "Catatan maksimal 255 karakter." })
      .trim()
      .max(255, "Catatan maksimal 255 karakter.")
      .nullish()
      .transform((note) => note || null),
    // AUD-34: account.updated_at dari daftar saldo = rekening yang dilihat admin saat mentransfer; kosong/berbeda → 409
    account_updated_at: z.iso
      .datetime({ offset: true, error: "Versi rekening tidak valid. Muat ulang halaman." })
      .nullish(),
  },
  { error: "Data pencairan tidak valid." },
);

export const refundSchema = z.object({ reference: referenceField }, { error: "Data pengembalian dana tidak valid." });

export const pageSchema = z.object({ page: z.coerce.number().int().min(1).catch(1) });

export type BankAccountInput = z.infer<typeof bankAccountSchema>;
export type PayoutInput = z.infer<typeof payoutSchema>;
export type RefundInput = z.infer<typeof refundSchema>;
