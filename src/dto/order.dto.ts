// Isi file: skema zod (aturan bentuk data) untuk isi permintaan dan query rute pesanan pembeli: quote, checkout,
// bayar, batal, daftar, dan ulasan. Dipakai routes (validate) dan handlers (parse) sebelum data diteruskan ke
// services. Nama kunci di sini adalah kontrak JSON dengan aplikasi, jadi tidak boleh diganti sembarangan.
import { z } from "zod";
import { BANK_VA } from "../utils/midtrans";

// Kolom harga/total dari aplikasi sengaja tidak dicantumkan sehingga dibuang z.object; server menghitung ulang.
const ITEMS_MSG = "Pilih 1–20 menu.";
const QTY_MSG = "Jumlah harus 1–1000.";
const OPTIONS_MSG = "Pilihan tidak valid.";
const NAME_MSG = "Nama 1–150 karakter.";
const PHONE_MSG = "Nomor HP harus diawali 08 dan berisi 10–13 angka.";
const PICKUP_TIME_MSG = "Waktu ambil tidak valid.";
const VOUCHER_CODE_MSG = "Kode voucher 1–30 karakter.";
// Aturan id: bilangan bulat ≥ 1.
const idField = (message: string) => z.number({ error: message }).int(message).min(1, message);
// Teks opsional: spasi di ujung dibuang, teks kosong menjadi null.
const optionalText = (message: string, max: number) =>
  z
    .string({ error: message })
    .trim()
    .max(max, message)
    .nullish()
    .transform((text) => text || null);

/**
 * Isi `POST /orders/quote`, sekaligus dasar isi checkout: 1–20 baris menu (jumlah 1–1000, paling banyak 10 opsi per
 * baris), titik temu, catatan, kode voucher (`promo_codes` paling banyak 2, `promo_code` untuk aplikasi versi lama),
 * nama/nomor pemesan, dan waktu ambil (format tanggal ISO). Harga dan total dari aplikasi sengaja tidak dicantumkan
 * sehingga dibuang; server selalu menghitung ulang.
 */
export const quoteSchema = z.object(
  {
    items: z
      .array(
        z.object(
          {
            menu_id: idField("Menu tidak tersedia."),
            qty: z.number({ error: QTY_MSG }).int(QTY_MSG).min(1, QTY_MSG).max(1000, QTY_MSG),
            // Galat tiap elemen dilaporkan di option_ids. Diurutkan dan dibuat unik supaya isi yang sama selalu
            // menghasilkan sidik jari (hash) yang sama, dipakai untuk mengenali kiriman ulang checkout.
            option_ids: z
              .array(z.unknown(), { error: OPTIONS_MSG })
              .max(10, OPTIONS_MSG)
              .refine(
                (values) => values.every((value) => Number.isInteger(value) && (value as number) >= 1),
                OPTIONS_MSG,
              )
              .default([])
              .transform((values) => [...new Set(values as number[])].sort((left, right) => left - right)),
          },
          { error: ITEMS_MSG },
        ),
        { error: ITEMS_MSG },
      )
      .min(1, ITEMS_MSG)
      .max(20, ITEMS_MSG),
    pickup_point_id: idField("Pilih titik temu."),
    note: optionalText("Catatan maksimal 255 karakter.", 255),
    promo_code: optionalText("Kode promo maksimal 30 karakter.", 30),
    // Voucher: paling banyak 1 voucher toko + 1 voucher platform (dicek di applyVouchers); promo_code lama digabung
    // oleh parseVoucherCodes.
    promo_codes: z
      .array(z.string({ error: VOUCHER_CODE_MSG }).trim().min(1, VOUCHER_CODE_MSG).max(30, VOUCHER_CODE_MSG), {
        error: VOUCHER_CODE_MSG,
      })
      .max(2, "Maksimal 2 voucher per pesanan.")
      .default([]),
    // Kosong atau spasi saja = null, lalu checkout memakai nama dan nomor dari akun pembeli.
    customer_name: optionalText(NAME_MSG, 150),
    customer_phone: z
      .string({ error: PHONE_MSG })
      .trim()
      .regex(/^(08\d{8,11})?$/, PHONE_MSG)
      .nullish()
      .transform((text) => text || null),
    pickup_at: z.iso
      .datetime({ offset: true, error: PICKUP_TIME_MSG })
      .nullish()
      .transform((text) => text ?? null),
  },
  { error: "Data pesanan tidak valid." },
);

// Metode bayar: tunai (`cod`), Virtual Account Midtrans (`va`, bank dipilih lewat POST /orders/:code/va), atau bayar
// online lewat halaman Midtrans Snap (`online`: QRIS, e-wallet, VA; lewat POST /orders/:code/online).
const PAYMENT_METHOD_MSG = "Pilih bayar tunai, Virtual Account, atau bayar online.";
/** Isi `POST /orders` (checkout): isi quote ditambah `payment_method` wajib (`cod`, `va`, atau `online`). */
export const orderSchema = quoteSchema.extend({
  payment_method: z.enum(["cod", "va", "online"], { error: PAYMENT_METHOD_MSG }),
});
/**
 * Isi `POST /orders/:code/va`: bank Virtual Account pilihan pembeli (BCA, BNI, atau BRI). Virtual Account = nomor
 * rekening sementara untuk membayar lewat transfer bank.
 */
export const vaSchema = z.object(
  { bank: z.enum(BANK_VA, { error: "Pilih bank BCA, BNI, atau BRI." }) },
  { error: "Pilih bank BCA, BNI, atau BRI." },
);
/**
 * Isi `POST /orders/:code/online`. Boleh kosong (aplikasi mobile); `kembali` = alamat halaman web setelah bayar,
 * yang di service diperiksa harus alamat web KateringKita sendiri (CORS_ORIGIN).
 */
export const payOnlineSchema = z.object({ kembali: z.url({ error: "Alamat kembali tidak valid." }).optional() });

/**
 * Header `Idempotency-Key` saat checkout: kode unik (UUID) yang sama untuk kiriman ulang, supaya server tidak membuat
 * pesanan dobel. Wajib UUID, dan diubah ke huruf kecil supaya kiriman ulang selalu dikenali sama.
 */
export const idempotencyKeySchema = z
  .uuid({ error: "Muat ulang aplikasi lalu coba lagi." })
  .transform((key) => key.toLowerCase());

/** Isi quote yang sudah lolos {@link quoteSchema} (opsi sudah unik dan terurut, teks kosong menjadi null). */
export type QuoteInput = z.infer<typeof quoteSchema>;
/** Isi checkout yang sudah lolos {@link orderSchema}. */
export type OrderInput = z.infer<typeof orderSchema>;

// Alasan batal/tolak; kosong menjadi null. Untuk tolak, alasan wajib, dan itu dicek pemanggilnya.
const REASON_MSG = "Alasan maksimal 255 karakter.";
/** Isi batal (pembeli) dan tolak (penjual): `reason` opsional, paling banyak 255 karakter, kosong menjadi null. */
export const reasonSchema = z.object({
  reason: z
    .string({ error: REASON_MSG })
    .trim()
    .max(255, REASON_MSG)
    .nullish()
    .transform((text) => text || null),
});
/**
 * Isi permintaan yang bukan objek (kosong, teks, atau daftar) dianggap `{}`, supaya skema yang semua kolomnya opsional
 * tetap lolos. Dipakai juga oleh handler notifikasi dan tiket.
 * @param body isi permintaan mentah
 * @returns isi itu sendiri bila berupa objek, selain itu `{}`
 */
export const bodyObject = (body: unknown) => (body && typeof body === "object" && !Array.isArray(body) ? body : {});

// Query daftar pesanan (pembeli dan penjual).
const PAGE_MSG = "Halaman tidak valid.";
const SEARCH_MSG = "Pencarian maksimal 50 karakter.";
/**
 * Kolom query daftar yang dipakai bersama (pesanan pembeli, pesanan toko, notifikasi): `q` kata cari paling banyak
 * 50 karakter, `updated_since` (waktu ISO; hanya ambil yang berubah sejak itu), `page` mulai 1, dan `limit` 1–100
 * (bawaan 20).
 */
export const listQueryBase = {
  q: z
    .string({ error: SEARCH_MSG })
    .trim()
    .max(50, SEARCH_MSG)
    .optional()
    .transform((text) => text || undefined),
  updated_since: z.iso.datetime({ offset: true, error: "Waktu tidak valid." }).optional(),
  page: z.coerce.number({ error: PAGE_MSG }).int(PAGE_MSG).min(1, PAGE_MSG).default(1),
  limit: z.coerce.number({ error: PAGE_MSG }).int(PAGE_MSG).min(1, PAGE_MSG).max(100, PAGE_MSG).default(20),
};
/** Query `GET /me/orders`: `tab` aktif/selesai/batal (bawaan `active`) ditambah {@link listQueryBase}. */
export const myOrdersQuerySchema = z.object({
  tab: z.enum(["active", "completed", "cancelled"], { error: "Tab tidak dikenal." }).default("active"),
  ...listQueryBase,
});
/** Query daftar pesanan pembeli yang sudah lolos {@link myOrdersQuerySchema}. */
export type MyOrdersQuery = z.infer<typeof myOrdersQuerySchema>;

// Ulasan per menu dalam pesanan yang sudah selesai.
const RATING_MSG = "Rating harus 1–5.";
const REVIEW_ITEMS_MSG = "Pilih 1–20 menu untuk diulas.";
/** Isi `POST /orders/:code/reviews`: 1–20 menu, masing-masing rating 1–5 dan komentar opsional ≤ 500 karakter. */
export const reviewSchema = z.object(
  {
    items: z
      .array(
        z.object(
          {
            menu_id: idField("Menu tidak ada di pesanan ini."),
            rating: z.number({ error: RATING_MSG }).int(RATING_MSG).min(1, RATING_MSG).max(5, RATING_MSG),
            comment: optionalText("Komentar maksimal 500 karakter.", 500),
          },
          { error: REVIEW_ITEMS_MSG },
        ),
        { error: REVIEW_ITEMS_MSG },
      )
      .min(1, REVIEW_ITEMS_MSG)
      .max(20, REVIEW_ITEMS_MSG),
  },
  { error: "Data ulasan tidak valid." },
);
/** Isi ulasan yang sudah lolos {@link reviewSchema}; diproses `kirimUlasan` di ulasan.service. */
export type ReviewInput = z.infer<typeof reviewSchema>;
