// Isi file: tanggal "hari ini" menurut WIB dan reset kuota harian menu toko. Tanggal WIB dipakai banyak service
// (katalog, pesanan, laporan, tiket, dan lainnya); reset kuota dipakai service menu penjual dan keranjang checkout.
// File ini ada di lapisan services dan langsung menulis ke database (tabel menus).
import { RowDataPacket } from "mysql2";
import { PoolConnection } from "mysql2/promise";

// Pengubah tanggal ke teks "YYYY-MM-DD" di zona Asia/Jakarta. Locale en-CA dipakai karena bentuk bawaannya sudah
// tahun-bulan-tanggal.
const wibDateFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Jakarta",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * Mengubah waktu menjadi tanggal WIB (Waktu Indonesia Barat, UTC+7) berbentuk `YYYY-MM-DD`. Tanggal inilah yang
 * dipakai sebagai "hari stok": kuota harian menu berganti hari tepat pukul 00.00 WIB, bukan pukul 00.00 UTC.
 * @param date waktu yang ingin diubah; bila tidak diisi, dipakai waktu sekarang
 * @returns tanggal WIB berbentuk `YYYY-MM-DD`, contoh `2026-11-01`
 */
export const getWibDate = (date = new Date()): string => wibDateFormat.format(date);

/**
 * Mengatur ulang kuota harian semua menu satu toko bila hari stoknya sudah lewat. Kuota harian = jumlah porsi yang
 * boleh dijual per hari (`daily_quota`). Tiap menu menyimpan angka untuk satu hari: kuota hari ini (`quota_today`),
 * terjual (`sold_today`), ditahan pesanan yang menunggu (`held_today`), dan tanggal WIB angka itu (`stock_date`).
 * Reset dilakukan "malas": tidak ada jadwal tengah malam, tetapi fungsi ini dipanggil sebelum angka stok dibaca atau
 * diubah (daftar dan detail menu penjual, ubah menu, ubah kuota, dan checkout bila semua menu dari satu toko).
 * Menu yang sudah dihapus tidak ikut direset. Menu dihapus dengan soft delete: barisnya tetap ada, hanya diberi
 * waktu hapus di kolom `deleted_at`.
 * @param conn       koneksi database; di dalam transaksi bila pemanggil sedang memakai transaksi
 * @param merchantId id toko
 * @param today      tanggal WIB hari ini (`YYYY-MM-DD`), dari {@link getWibDate}
 * @returns tidak ada; angka stok di database sudah diperbarui
 */
export async function refreshDailyQuota(
  conn: Pick<PoolConnection, "query">,
  merchantId: number,
  today: string,
): Promise<void> {
  // 1. Cek dulu tanpa mengunci apakah ada menu dengan tanggal stok kosong atau lebih lama dari hari ini. UPDATE selalu
  //    mengunci semua baris menu toko, padahal reset hanya perlu sekali sehari, jadi kalau tidak ada langsung selesai.
  const [staleRows] = await conn.query<RowDataPacket[]>(
    "SELECT 1 FROM menus WHERE merchant_id = ? AND deleted_at IS NULL AND (stock_date IS NULL OR stock_date < ?) LIMIT 1",
    [merchantId, today],
  );
  if (staleRows.length === 0) return;
  // 2. Kembalikan kuota hari ini ke kuota harian, nolkan terjual dan ditahan, lalu catat tanggal hari ini.
  //    - Tanggal hanya boleh maju (`<`): permintaan yang menghitung tanggal kemarin tepat sebelum tengah malam tidak
  //      menghapus angka terjual dan ditahan yang sudah milik hari ini.
  //    - `updated_at = updated_at` membuat waktu terakhir diubah tidak bergeser, karena reset harian bukan perubahan
  //      data oleh penjual.
  //    - ORDER BY id: baris menu dikunci berurutan id, sama dengan checkout dan releaseStock, supaya dua transaksi
  //      tidak saling menunggu kunci milik yang lain (deadlock).
  await conn.query(
    `UPDATE menus SET quota_today = daily_quota, sold_today = 0, held_today = 0, stock_date = ?, updated_at = updated_at
     WHERE merchant_id = ? AND deleted_at IS NULL AND (stock_date IS NULL OR stock_date < ?) ORDER BY id`,
    [today, merchantId, today],
  );
}
