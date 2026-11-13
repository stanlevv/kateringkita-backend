import { z } from "zod";

// Tiket bantuan (CS). Kategori tampil di aplikasi: Akun, Pembayaran, Pesanan, Penjual, Aplikasi, Lainnya.
export const KATEGORI_TIKET = ["akun", "pembayaran", "pesanan", "penjual", "aplikasi", "lainnya"] as const;
// open = menunggu admin, answered = admin sudah membalas (menunggu pembeli), closed = selesai
export const STATUS_TIKET = ["open", "answered", "closed"] as const;

const KATEGORI = "Pilih kategori.";
const JUDUL = "Judul 3–120 karakter.";
const PESAN = "Pesan 5–2000 karakter.";
const BALASAN = "Pesan 1–2000 karakter.";
const PESANAN = "Pesanan tidak ditemukan.";
const CARI = "Pencarian maksimal 100 karakter.";

export const buatTiketSchema = z.object({
  category: z.enum(KATEGORI_TIKET, { error: KATEGORI }),
  subject: z.string({ error: JUDUL }).trim().min(3, JUDUL).max(120, JUDUL),
  message: z.string({ error: PESAN }).trim().min(5, PESAN).max(2000, PESAN),
  // opsional: kosong/spasi = tanpa pesanan; kepemilikan dicek di service (bukan milik → pesan yang sama)
  order_code: z.string({ error: PESANAN }).trim().max(20, PESANAN).nullish().transform((s) => s || null),
});
export type BuatTiket = z.infer<typeof buatTiketSchema>;

// balasan pembeli & admin
export const balasTiketSchema = z.object({
  body: z.string({ error: BALASAN }).trim().min(1, BALASAN).max(2000, BALASAN),
});

// limit 1–50, bawaan 20: nilai tak valid → bawaan, > 50 → 50 (pola halamanSchema katalog & admin)
const halaman = {
  page: z.coerce.number().int().min(1).catch(1),
  limit: z.coerce.number().int().min(1).catch(20).transform((n) => Math.min(n, 50)),
};
export const daftarTiketSchema = z.object(halaman);
export type DaftarTiket = z.infer<typeof daftarTiketSchema>;

// GET /admin/tickets; status kosong (tab "Semua") = tanpa filter
export const daftarTiketAdminSchema = z.object({
  status: z.preprocess((v) => (v === "" ? undefined : v), z.enum(STATUS_TIKET, { error: "Status tidak dikenal." }).optional()),
  q: z.string({ error: CARI }).trim().max(100, CARI).optional().transform((s) => s || undefined),
  ...halaman,
});
export type DaftarTiketAdmin = z.infer<typeof daftarTiketAdminSchema>;
