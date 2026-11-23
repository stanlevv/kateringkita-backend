// Isi file: daftar bank tujuan pencairan dan skema zod untuk rekening penjual, pencatatan pencairan, penandaan refund,
// dan halaman riwayat. zod = pustaka yang memeriksa bentuk data masuk; data yang tidak lolos dijawab 400 beserta pesan
// per kolom. Dipakai routes/merchant.ts, routes/admin.ts, dan payout.service. Nama kunci di sini adalah kontrak JSON.
import { z } from "zod";

/**
 * Bank dan e-wallet tujuan pencairan: kode (disimpan di database) → nama yang ditampilkan. Daftar ini dikirim ke web
 * lewat `GET /merchant/payouts`, jadi web tidak menyimpan salinannya sendiri.
 */
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
/**
 * Nama tampilan sebuah kode bank.
 * @param code kode bank dari database, contoh `bca`
 * @returns nama bank, atau kode itu sendiri bila tidak dikenal
 */
export const getBankName = (code: string) => PAYOUT_BANKS[code as BankCode] ?? code;

const ACCOUNT_NUMBER_MSG = "Nomor rekening 6–20 angka.";
const ACCOUNT_NAME_MSG = "Nama pemilik rekening 3–100 karakter.";
const REFERENCE_MSG = "Nomor referensi transfer 3–100 karakter.";
const referenceField = z.string({ error: REFERENCE_MSG }).trim().min(3, REFERENCE_MSG).max(100, REFERENCE_MSG);

/**
 * Isi `PUT /merchant/payout-account`: `bank` (kode dari {@link PAYOUT_BANKS}), `account_number` (6–20 angka; spasi,
 * titik, dan strip pemisah dibuang dulu, jadi "123-456 789" menjadi "123456789"), `account_name`, dan `password`
 * (kata sandi akun, diperiksa di service).
 */
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

/**
 * Isi `POST /admin/payouts` (mencatat pencairan setelah admin mentransfer). `until` = `as_of` dari
 * `GET /admin/payouts/balances`: hanya pesanan yang selesai sampai waktu itu yang ikut, dan `amount` (rupiah, bilangan
 * bulat ≥ 1) harus sama dengan jumlah saldonya. `account_updated_at` = `account.updated_at` dari daftar saldo, yaitu
 * versi rekening yang dilihat admin saat mentransfer; kosong atau berbeda dengan versi sekarang ditolak 409 di
 * service. `reference` = nomor referensi transfer, `note` = catatan opsional.
 */
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
    account_updated_at: z.iso
      .datetime({ offset: true, error: "Versi rekening tidak valid. Muat ulang halaman." })
      .nullish(),
  },
  { error: "Data pencairan tidak valid." },
);

/** Isi `POST /admin/refunds/:code`: `reference` = nomor referensi transfer pengembalian dana (3–100 karakter). */
export const refundSchema = z.object({ reference: referenceField }, { error: "Data pengembalian dana tidak valid." });

/** Query halaman riwayat pencairan admin: `page` mulai 1; nilai yang tidak valid dianggap 1. */
export const pageSchema = z.object({ page: z.coerce.number().int().min(1).catch(1) });

/** Rekening penjual yang sudah lolos {@link bankAccountSchema}. */
export type BankAccountInput = z.infer<typeof bankAccountSchema>;
/** Pencatatan pencairan yang sudah lolos {@link payoutSchema}. */
export type PayoutInput = z.infer<typeof payoutSchema>;
/** Penandaan refund yang sudah lolos {@link refundSchema}. */
export type RefundInput = z.infer<typeof refundSchema>;
