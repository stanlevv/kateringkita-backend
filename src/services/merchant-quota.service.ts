import { RowDataPacket } from "mysql2";
import { PoolConnection } from "mysql2/promise";

const wibDateFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Jakarta",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

// Tanggal stok = tanggal WIB "YYYY-MM-DD" (R-12)
export const getWibDate = (date = new Date()): string => wibDateFormat.format(date);

// Reset malas kuota harian toko (R-12, D4); updated_at tidak digeser (D7). Dipakai lagi oleh F06 sebelum mengunci menu.
// Tanggal hanya maju (`<`): permintaan yang menghitung tanggal kemarin tepat sebelum tengah malam tidak menghapus terjual/ditahan hari ini.
export async function refreshDailyQuota(
  conn: Pick<PoolConnection, "query">,
  merchantId: number,
  today: string,
): Promise<void> {
  // cek tanpa kunci dulu: UPDATE selalu mengunci semua baris menu toko, padahal reset hanya perlu sekali sehari
  const [staleRows] = await conn.query<RowDataPacket[]>(
    "SELECT 1 FROM menus WHERE merchant_id = ? AND deleted_at IS NULL AND (stock_date IS NULL OR stock_date < ?) LIMIT 1",
    [merchantId, today],
  );
  if (staleRows.length === 0) return;
  // ORDER BY id: kunci baris menu diambil urut id seperti checkout & releaseStock (tanpa siklus kunci)
  await conn.query(
    `UPDATE menus SET quota_today = daily_quota, sold_today = 0, held_today = 0, stock_date = ?, updated_at = updated_at
     WHERE merchant_id = ? AND deleted_at IS NULL AND (stock_date IS NULL OR stock_date < ?) ORDER BY id`,
    [today, merchantId, today],
  );
}
