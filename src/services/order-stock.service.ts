// Pelepasan porsi stok menu yang ditahan pesanan. Layanan paling dalam: dipanggil order-status.service
// saat transisi (konfirmasi, batal, tolak, kadaluarsa), tidak dipanggil handler secara langsung.
import { RowDataPacket } from "mysql2";
import { PoolConnection } from "mysql2/promise";

/**
 * D14 (R-01, R-03, R-12): lepas porsi yang ditahan pesanan. "terjual" = konfirmasi (F07), "kembali" = batal/tolak/kadaluarsa (F07/F08).
 * F07 D4: "batal" = tolak/batal setelah dikonfirmasi → porsi terjual dikembalikan (held tidak disentuh), dijepit ≥ 0.
 * Pemanggil (F07 konfirmasi/batal, F08 kadaluarsa) mengunci baris `orders` dulu, lalu fungsi ini mengunci menu urut id.
 * Penghitung harian hanya disentuh bila tanggal stok menu = tanggal stok pesanan (hold kemarin tidak mengurangi hari ini);
 * orders.stock_date NULL (sebelum F06) tidak pernah cocok. Tanpa filter deleted_at/is_active agar menu terhapus tetap dilepas.
 *
 * @param conn koneksi di dalam transaksi pemanggil
 * @param orderId id pesanan yang porsinya dilepas
 * @param outcome nasib porsi: `terjual` (held → sold), `kembali` (held dikurangi), `batal` (sold dikurangi)
 */
export async function releaseStock(
  conn: Pick<PoolConnection, "query">,
  orderId: number,
  outcome: "terjual" | "kembali" | "batal",
): Promise<void> {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT DATE_FORMAT(o.stock_date, '%Y-%m-%d') AS stock_date, i.menu_id, SUM(i.qty) AS qty FROM orders o JOIN order_items i ON i.order_id = o.id
     WHERE o.id = ? GROUP BY o.stock_date, i.menu_id ORDER BY i.menu_id`,
    [orderId],
  );
  const isCancel = outcome === "batal";
  for (const r of rows) {
    const qty = Number(r.qty);
    // perubahan porsi terjual: +qty (terjual), −qty (batal), 0 (kembali)
    const d = outcome === "terjual" ? qty : isCancel ? -qty : 0;
    await conn.query(
      `UPDATE menus SET held_today = IF(? AND stock_date = ?, GREATEST(held_today - ?, 0), held_today),
         sold_today = IF(stock_date = ?, GREATEST(sold_today + ?, 0), sold_today),
         sold_total = GREATEST(sold_total + ?, 0), updated_at = updated_at
       WHERE id = ?`,
      [!isCancel, r.stock_date, qty, r.stock_date, d, d, r.menu_id],
    );
  }
}
