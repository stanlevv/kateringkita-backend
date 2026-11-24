// Isi file: pelepasan porsi stok menu yang ditahan sebuah pesanan. Lapisan services paling dalam: hanya dipanggil
// order-status.service saat status pesanan berubah (diterima, batal, tolak, kadaluarsa), tidak pernah oleh handler.
import { RowDataPacket } from "mysql2";
import { PoolConnection } from "mysql2/promise";

/**
 * Memperbarui penghitung stok untuk semua menu dalam satu pesanan. Tiap menu punya penghitung harian porsi ditahan
 * (`held_today`, milik pesanan yang masih menunggu) dan porsi terjual (`sold_today`), ditambah total terjual
 * sepanjang masa (`sold_total`).
 * - `terjual`: pesanan diterima/lunas, porsi tahanan pindah menjadi terjual.
 * - `kembali`: pesanan menunggu dibatalkan/ditolak/kadaluarsa, porsi tahanan dilepas.
 * - `batal`: pesanan yang sudah diterima dibatalkan/ditolak, porsi terjual dikembalikan (tahanan tidak disentuh).
 * Angka tidak pernah dibuat kurang dari 0. Penghitung harian hanya diubah bila tanggal stok menu sama dengan tanggal
 * stok pesanan, supaya pesanan kemarin tidak mengurangi stok hari ini; pesanan sangat lama tanpa tanggal stok tidak
 * pernah cocok. Menu yang sudah dihapus atau dinonaktifkan tetap diperbarui.
 * Pemanggil sudah mengunci baris pesanan; fungsi ini mengunci menu urut id, sama seperti checkout, supaya dua
 * transaksi tidak saling menunggu selamanya (deadlock).
 * @param conn    koneksi di dalam transaksi pemanggil (transaksi = perubahan yang disimpan semua atau dibatalkan semua)
 * @param orderId id pesanan yang porsinya diperbarui
 * @param outcome nasib porsi: `terjual`, `kembali`, atau `batal` (lihat di atas)
 */
export async function releaseStock(
  conn: Pick<PoolConnection, "query">,
  orderId: number,
  outcome: "terjual" | "kembali" | "batal",
): Promise<void> {
  // 1. Jumlah porsi per menu dalam pesanan ini, beserta tanggal stok pesanannya.
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT DATE_FORMAT(o.stock_date, '%Y-%m-%d') AS stock_date, i.menu_id, SUM(i.qty) AS qty FROM orders o JOIN order_items i ON i.order_id = o.id
     WHERE o.id = ? GROUP BY o.stock_date, i.menu_id ORDER BY i.menu_id`,
    [orderId],
  );
  const isCancel = outcome === "batal";
  // 2. Perbarui penghitung tiap menu, urut id menu.
  for (const row of rows) {
    const qty = Number(row.qty);
    // Perubahan porsi terjual: +qty (terjual), −qty (batal), 0 (kembali).
    const soldChange = outcome === "terjual" ? qty : isCancel ? -qty : 0;
    await conn.query(
      `UPDATE menus SET held_today = IF(? AND stock_date = ?, GREATEST(held_today - ?, 0), held_today),
         sold_today = IF(stock_date = ?, GREATEST(sold_today + ?, 0), sold_today),
         sold_total = GREATEST(sold_total + ?, 0), updated_at = updated_at
       WHERE id = ?`,
      [!isCancel, row.stock_date, qty, row.stock_date, soldChange, soldChange, row.menu_id],
    );
  }
}
