// Skema zod untuk body/query rute pesanan pembeli (quote, checkout, bayar, batal, daftar, ulasan).
// Dipakai di routes (validate) dan handlers (parse) sebelum data diteruskan ke services. Kunci objek = kontrak JSON API.
import { z } from "zod";
import { BANK_VA } from "../utils/midtrans";

// F06 (C-09): field harga/total dari client tidak dideklarasikan sehingga dibuang z.object (R-07, D1)
const ITEMS = "Pilih 1–20 menu.";
const QTY = "Jumlah harus 1–1000.";
const OPTIONS = "Pilihan tidak valid.";
const NAME = "Nama 1–150 karakter.";
const PHONE = "Nomor HP harus diawali 08 dan berisi 10–13 angka.";
const PICKUP_TIME = "Waktu ambil tidak valid.";
const VOUCHER_CODE = "Kode voucher 1–30 karakter.";
const id = (message: string) => z.number({ error: message }).int(message).min(1, message);
// teks opsional: trim, kosong → null
const optionalText = (message: string, max: number) =>
  z
    .string({ error: message })
    .trim()
    .max(max, message)
    .nullish()
    .transform((s) => s || null);

/**
 * Body `POST /orders/quote` sekaligus dasar body checkout: 1–20 baris menu (qty 1–1000, maks 10 opsi per baris),
 * titik temu, catatan, kode voucher (`promo_codes` maks 2, `promo_code` lama), nama/nomor pemesan, dan waktu ambil ISO.
 * Harga dan total dari klien sengaja tidak dideklarasikan sehingga dibuang (R-07); server menghitung ulang.
 */
export const quoteSchema = z.object(
  {
    items: z
      .array(
        z.object(
          {
            menu_id: id("Menu tidak tersedia."),
            qty: z.number({ error: QTY }).int(QTY).min(1, QTY).max(1000, QTY),
            // galat per elemen dilaporkan di option_ids; diurutkan & unik agar hash idempotensi stabil (D6)
            option_ids: z
              .array(z.unknown(), { error: OPTIONS })
              .max(10, OPTIONS)
              .refine((a) => a.every((n) => Number.isInteger(n) && (n as number) >= 1), OPTIONS)
              .default([])
              .transform((a) => [...new Set(a as number[])].sort((x, y) => x - y)),
          },
          { error: ITEMS },
        ),
        { error: ITEMS },
      )
      .min(1, ITEMS)
      .max(20, ITEMS),
    pickup_point_id: id("Pilih titik temu."),
    note: optionalText("Catatan maksimal 255 karakter.", 255),
    promo_code: optionalText("Kode promo maksimal 30 karakter.", 30),
    // voucher: maks 1 toko + 1 platform (aturan slot dicek di applyVouchers); promo_code lama digabung oleh parseVoucherCodes
    promo_codes: z
      .array(z.string({ error: VOUCHER_CODE }).trim().min(1, VOUCHER_CODE).max(30, VOUCHER_CODE), {
        error: VOUCHER_CODE,
      })
      .max(2, "Maksimal 2 voucher per pesanan.")
      .default([]),
    // kosong/spasi = null → nama & nomor akun (API.md)
    customer_name: optionalText(NAME, 150),
    customer_phone: z
      .string({ error: PHONE })
      .trim()
      .regex(/^(08\d{8,11})?$/, PHONE)
      .nullish()
      .transform((s) => s || null),
    pickup_at: z.iso
      .datetime({ offset: true, error: PICKUP_TIME })
      .nullish()
      .transform((s) => s ?? null),
  },
  { error: "Data pesanan tidak valid." },
);

// F10/F26: tunai, VA Midtrans (bank dipilih di POST /orders/:code/va), atau bayar online lewat halaman Snap Midtrans
// (QRIS, e-wallet, VA; POST /orders/:code/online). QRIS statis toko dengan verifikasi manual dihapus di F26.
const PAYMENT_METHOD = "Pilih bayar tunai, Virtual Account, atau bayar online.";
/** Body `POST /orders` (checkout): isi quote ditambah `payment_method` wajib (`cod`, `va`, atau `online`). */
export const orderSchema = quoteSchema.extend({
  payment_method: z.enum(["cod", "va", "online"], { error: PAYMENT_METHOD }),
});
/** Body `POST /orders/:code/va`: bank Virtual Account pilihan pembeli (BCA, BNI, atau BRI). */
export const vaSchema = z.object(
  { bank: z.enum(BANK_VA, { error: "Pilih bank BCA, BNI, atau BRI." }) },
  { error: "Pilih bank BCA, BNI, atau BRI." },
);
/**
 * Body `POST /orders/:code/online` (F26). Body boleh kosong (aplikasi mobile); `kembali` = URL halaman web
 * setelah bayar, asalnya dicek terhadap CORS_ORIGIN di service.
 */
export const payOnlineSchema = z.object({ kembali: z.url({ error: "Alamat kembali tidak valid." }).optional() });

/** Header `Idempotency-Key` checkout (D6): wajib UUID, disimpan huruf kecil agar kiriman ulang dikenali sama. */
export const idempotencyKeySchema = z
  .uuid({ error: "Muat ulang aplikasi lalu coba lagi." })
  .transform((s) => s.toLowerCase());

/** Data quote yang sudah lolos {@link quoteSchema} (opsi sudah unik dan terurut, teks kosong menjadi null). */
export type QuoteInput = z.infer<typeof quoteSchema>;
/** Data checkout yang sudah lolos {@link orderSchema}. */
export type OrderInput = z.infer<typeof orderSchema>;

// F07 D8: alasan batal/tolak; kosong → null (wajib-nya tolak dicek pemanggil)
const REASON = "Alasan maksimal 255 karakter.";
/** Body batal (pembeli) dan tolak (penjual): `reason` opsional maks 255 karakter, kosong menjadi null. */
export const reasonSchema = z.object({
  reason: z
    .string({ error: REASON })
    .trim()
    .max(255, REASON)
    .nullish()
    .transform((s) => s || null),
});
/**
 * D8: body yang bukan objek (kosong, teks, array) dianggap `{}` agar skema yang semua field-nya opsional tetap lolos.
 * Dipakai juga oleh handler notifikasi dan tiket.
 */
export const bodyObject = (b: unknown) => (b && typeof b === "object" && !Array.isArray(b) ? b : {});

// F07 D10–D12: query daftar pesanan (pembeli & penjual)
const PAGE = "Halaman tidak valid.";
const SEARCH = "Pencarian maksimal 50 karakter.";
/**
 * Field query daftar yang dipakai bersama (pesanan pembeli, pesanan toko, notifikasi): `q` pencarian maks 50 karakter,
 * `updated_since` ISO untuk sinkron bertahap, `page` mulai 1, dan `limit` 1–100 (bawaan 20).
 */
export const listQueryBase = {
  q: z
    .string({ error: SEARCH })
    .trim()
    .max(50, SEARCH)
    .optional()
    .transform((s) => s || undefined),
  updated_since: z.iso.datetime({ offset: true, error: "Waktu tidak valid." }).optional(),
  page: z.coerce.number({ error: PAGE }).int(PAGE).min(1, PAGE).default(1),
  limit: z.coerce.number({ error: PAGE }).int(PAGE).min(1, PAGE).max(100, PAGE).default(20),
};
/** Query `GET /me/orders` (C-14): `tab` aktif/selesai/batal (bawaan `active`) ditambah {@link listQueryBase}. */
export const myOrdersQuerySchema = z.object({
  tab: z.enum(["active", "completed", "cancelled"], { error: "Tab tidak dikenal." }).default("active"),
  ...listQueryBase,
});
/** Query daftar pesanan pembeli yang sudah lolos {@link myOrdersQuerySchema}. */
export type MyOrdersQuery = z.infer<typeof myOrdersQuerySchema>;

// F13: ulasan per menu dalam pesanan selesai
const RATING = "Rating harus 1–5.";
const REVIEW_ITEMS = "Pilih 1–20 menu untuk diulas.";
/** Body `POST /orders/:code/reviews`: 1–20 menu, masing-masing rating 1–5 dan komentar opsional maks 500 karakter. */
export const reviewSchema = z.object(
  {
    items: z
      .array(
        z.object(
          {
            menu_id: id("Menu tidak ada di pesanan ini."),
            rating: z.number({ error: RATING }).int(RATING).min(1, RATING).max(5, RATING),
            comment: optionalText("Komentar maksimal 500 karakter.", 500),
          },
          { error: REVIEW_ITEMS },
        ),
        { error: REVIEW_ITEMS },
      )
      .min(1, REVIEW_ITEMS)
      .max(20, REVIEW_ITEMS),
  },
  { error: "Data ulasan tidak valid." },
);
/** Data ulasan yang sudah lolos {@link reviewSchema}; diproses `kirimUlasan` di ulasan.service. */
export type ReviewInput = z.infer<typeof reviewSchema>;
