import { z } from "zod";
import { BANK_VA } from "../utils/midtrans";

// F06 (C-09): field harga/total dari client tidak dideklarasikan sehingga dibuang z.object (R-07, D1)
const ITEMS = "Pilih 1–20 menu.";
const QTY = "Jumlah harus 1–1000.";
const OPSI = "Pilihan tidak valid.";
const NAMA = "Nama 1–150 karakter.";
const HP = "Nomor HP harus diawali 08 dan berisi 10–13 angka.";
const WAKTU = "Waktu ambil tidak valid.";
const id = (pesan: string) => z.number({ error: pesan }).int(pesan).min(1, pesan);
// teks opsional: trim, kosong → null
const teks = (pesan: string, maks: number) =>
  z.string({ error: pesan }).trim().max(maks, pesan).nullish().transform((s) => s || null);

export const quoteSchema = z.object({
  items: z.array(z.object({
    menu_id: id("Menu tidak tersedia."),
    qty: z.number({ error: QTY }).int(QTY).min(1, QTY).max(1000, QTY),
    // galat per elemen dilaporkan di option_ids; diurutkan & unik agar hash idempotensi stabil (D6)
    option_ids: z.array(z.unknown(), { error: OPSI }).max(10, OPSI)
      .refine((a) => a.every((n) => Number.isInteger(n) && (n as number) >= 1), OPSI)
      .default([])
      .transform((a) => [...new Set(a as number[])].sort((x, y) => x - y)),
  }, { error: ITEMS }), { error: ITEMS }).min(1, ITEMS).max(20, ITEMS),
  pickup_point_id: id("Pilih titik temu."),
  note: teks("Catatan maksimal 255 karakter.", 255),
  promo_code: teks("Kode promo maksimal 30 karakter.", 30),
  // kosong/spasi = null → nama & nomor akun (API.md)
  customer_name: teks(NAMA, 150),
  customer_phone: z.string({ error: HP }).trim().regex(/^(08\d{8,11})?$/, HP).nullish().transform((s) => s || null),
  pickup_at: z.iso.datetime({ offset: true, error: WAKTU }).nullish().transform((s) => s ?? null),
}, { error: "Data pesanan tidak valid." });

// F10/F26: tunai, VA Midtrans (bank dipilih di POST /orders/:code/va), atau bayar online lewat halaman Snap Midtrans
// (QRIS, e-wallet, VA; POST /orders/:code/online). QRIS statis toko dengan verifikasi manual dihapus di F26.
const BAYAR = "Pilih bayar tunai, Virtual Account, atau bayar online.";
export const pesananSchema = quoteSchema.extend({ payment_method: z.enum(["cod", "va", "online"], { error: BAYAR }) });
export const vaSchema = z.object({ bank: z.enum(BANK_VA, { error: "Pilih bank BCA, BNI, atau BRI." }) }, { error: "Pilih bank BCA, BNI, atau BRI." });
// body boleh kosong (aplikasi mobile); `kembali` = halaman web setelah bayar, dicek asalnya di service
export const bayarOnlineSchema = z.object({ kembali: z.url({ error: "Alamat kembali tidak valid." }).optional() });

// D6: Idempotency-Key UUID, huruf kecil
export const kunciSchema = z.uuid({ error: "Muat ulang aplikasi lalu coba lagi." }).transform((s) => s.toLowerCase());

export type QuoteInput = z.infer<typeof quoteSchema>;
export type PesananInput = z.infer<typeof pesananSchema>;

// F07 D8: alasan batal/tolak; kosong → null (wajib-nya tolak dicek pemanggil)
const ALASAN = "Alasan maksimal 255 karakter.";
export const alasanSchema = z.object({
  reason: z.string({ error: ALASAN }).trim().max(255, ALASAN).nullish().transform((s) => s || null),
});
// D8: body bukan objek (kosong, teks) dianggap {}
export const bodyObjek = (b: unknown) => (b && typeof b === "object" && !Array.isArray(b) ? b : {});

// F07 D10–D12: query daftar pesanan (pembeli & penjual)
const HALAMAN = "Halaman tidak valid.";
const CARI = "Pencarian maksimal 50 karakter.";
export const daftarDasar = {
  q: z.string({ error: CARI }).trim().max(50, CARI).optional().transform((s) => s || undefined),
  updated_since: z.iso.datetime({ offset: true, error: "Waktu tidak valid." }).optional(),
  page: z.coerce.number({ error: HALAMAN }).int(HALAMAN).min(1, HALAMAN).default(1),
  limit: z.coerce.number({ error: HALAMAN }).int(HALAMAN).min(1, HALAMAN).max(100, HALAMAN).default(20),
};
export const daftarSayaSchema = z.object({
  tab: z.enum(["active", "completed", "cancelled"], { error: "Tab tidak dikenal." }).default("active"),
  ...daftarDasar,
});
export type DaftarSaya = z.infer<typeof daftarSayaSchema>;

// F13: ulasan per menu dalam pesanan selesai
const RATING = "Rating harus 1–5.";
const ULASAN = "Pilih 1–20 menu untuk diulas.";
export const ulasanSchema = z.object({
  items: z.array(z.object({
    menu_id: id("Menu tidak ada di pesanan ini."),
    rating: z.number({ error: RATING }).int(RATING).min(1, RATING).max(5, RATING),
    comment: teks("Komentar maksimal 500 karakter.", 500),
  }, { error: ULASAN }), { error: ULASAN }).min(1, ULASAN).max(20, ULASAN),
}, { error: "Data ulasan tidak valid." });
export type UlasanInput = z.infer<typeof ulasanSchema>;
