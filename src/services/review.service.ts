// Isi file: ulasan menu. Pembeli mengulas menu dari pesanannya yang sudah selesai, dan penjual melihat daftar ulasan
// tokonya. Alurnya routes/order.ts (kirim ulasan) atau routes/merchant.ts (daftar ulasan) → handler → file ini →
// database. Perhitungan ulang rating juga dipakai moderasi admin (admin-moderation.service) saat ulasan disembunyikan.
import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { ReviewInput } from "../dto/order.dto";
import { AppError } from "../utils/errors";
import { Conn, dalamTransaksi } from "./admin-audit.service";
import { getMerchantId } from "./merchant-menu.service";

// Ulasan = rating 1–5 bintang dan komentar opsional untuk satu menu dalam satu pesanan. Satu menu hanya bisa diulas
// sekali per pesanan. Ulasan yang disembunyikan admin (`hidden_at` terisi) tidak ikut rating dan tidak tampil.

/**
 * Menghitung ulang rating rata-rata dan jumlah ulasan untuk menu-menu tertentu dan tokonya, dari ulasan yang tidak
 * disembunyikan. Dipanggil setelah ulasan ditambah, atau disembunyikan / dimunculkan lagi oleh admin.
 * @param conn       koneksi database (biasanya di dalam transaksi pemanggil)
 * @param menuIds    id menu yang ratingnya dihitung ulang; boleh kosong (hanya toko yang dihitung)
 * @param merchantId id toko yang ratingnya dihitung ulang
 * @returns selesai setelah kolom `rating_avg` dan `rating_count` menu dan toko diperbarui
 */
export async function recalculateRatings(conn: Pick<Conn, "query">, menuIds: number[], merchantId: number) {
  // 1. Rating menu. `updated_at = updated_at` menjaga waktu ubah menu tetap, karena isi menunya tidak berubah.
  if (menuIds.length) {
    await conn.query(
      `UPDATE menus m SET rating_avg = (SELECT COALESCE(AVG(r.rating), 0) FROM reviews r WHERE r.menu_id = m.id AND r.hidden_at IS NULL),
         rating_count = (SELECT COUNT(*) FROM reviews r WHERE r.menu_id = m.id AND r.hidden_at IS NULL), updated_at = updated_at
       WHERE m.id IN (?)`,
      [menuIds],
    );
  }
  // 2. Rating toko = rata-rata semua ulasan menu toko itu.
  await conn.query(
    `UPDATE merchants t SET
       rating_avg = (SELECT COALESCE(AVG(r.rating), 0) FROM reviews r JOIN menus m ON m.id = r.menu_id WHERE m.merchant_id = t.id AND r.hidden_at IS NULL),
       rating_count = (SELECT COUNT(*) FROM reviews r JOIN menus m ON m.id = r.menu_id WHERE m.merchant_id = t.id AND r.hidden_at IS NULL)
     WHERE t.id = ?`,
    [merchantId],
  );
}

/**
 * Menyimpan ulasan pembeli untuk satu atau beberapa menu dari pesanannya yang sudah selesai, lalu memperbarui rating
 * menu dan toko. Semua menu disimpan sekaligus atau tidak sama sekali.
 * @param userId id pembeli yang login
 * @param code   kode pesanan
 * @param data   ulasan yang sudah lolos reviewSchema: daftar `{ menu_id, rating, comment }`
 * @returns `{ order_code, reviewed_menu_ids }`
 * @throws 404 pesanan tidak ada atau milik pembeli lain, 409 pesanan belum selesai, atau ada menu yang tidak ada di
 *         pesanan / sudah diulas / dikirim dua kali (galat per baris `items.N.menu_id`)
 */
export async function createReview(userId: number, code: string, data: ReviewInput) {
  return dalamTransaksi(async (conn) => {
    // 1. Kunci pesanan milik pembeli ini; hanya pesanan selesai yang boleh diulas.
    const [[order]] = await conn.query<RowDataPacket[]>(
      "SELECT id, merchant_id, status FROM orders WHERE code = ? AND customer_id = ? FOR UPDATE",
      [code, userId],
    );
    if (!order) throw new AppError(404, "NOT_FOUND", "Pesanan tidak ditemukan.");
    if (order.status !== "completed")
      throw new AppError(409, "CONFLICT", "Ulasan hanya bisa untuk pesanan yang sudah selesai.");
    // 2. Peta menu di pesanan ini → sudah pernah diulas atau belum.
    const [items] = await conn.query<RowDataPacket[]>(
      `SELECT DISTINCT i.menu_id, r.id AS sudah FROM order_items i LEFT JOIN reviews r ON r.order_id = i.order_id AND r.menu_id = i.menu_id
       WHERE i.order_id = ?`,
      [order.id],
    );
    const reviewedByMenu = new Map(items.map((item) => [item.menu_id as number, Boolean(item.sudah)]));
    // 3. Periksa setiap baris kiriman; semua galat dikumpulkan dulu supaya tampil sekaligus.
    const fieldErrors: Record<string, string[]> = {};
    const seenMenuIds = new Set<number>();
    data.items.forEach((item, i) => {
      if (!reviewedByMenu.has(item.menu_id)) fieldErrors[`items.${i}.menu_id`] = ["Menu tidak ada di pesanan ini."];
      else if (reviewedByMenu.get(item.menu_id) || seenMenuIds.has(item.menu_id))
        fieldErrors[`items.${i}.menu_id`] = ["Menu ini sudah diulas."];
      seenMenuIds.add(item.menu_id);
    });
    if (Object.keys(fieldErrors).length)
      throw new AppError(409, "CONFLICT", "Sebagian menu sudah diulas atau tidak ada di pesanan ini.", fieldErrors);
    // 4. Simpan semua ulasan dalam satu perintah, lalu hitung ulang rating menu dan toko.
    await conn.query("INSERT INTO reviews (order_id, menu_id, customer_id, rating, comment) VALUES ?", [
      data.items.map((item) => [order.id, item.menu_id, userId, item.rating, item.comment]),
    ]);
    await recalculateRatings(
      conn,
      data.items.map((item) => item.menu_id),
      order.merchant_id,
    );
    return { order_code: code, reviewed_menu_ids: data.items.map((item) => item.menu_id) };
  });
}

// shortcut: tanpa paginasi (fe menyaring & memotong 10 per halaman); upgrade bila satu toko > beberapa ribu ulasan
/**
 * Daftar ulasan untuk semua menu toko penjual yang login, yang terbaru di atas. Nama pembeli dikirim asli; web yang
 * menyamarkannya. Ulasan yang disembunyikan admin tidak ikut.
 * @param userId id pengguna penjual dari token login
 * @returns daftar `{ id, menu_id, menu_name, customer_name, rating, comment, created_at }`
 * @throws 404 bila pengguna ini tidak punya toko
 */
export async function listMerchantReviews(userId: number) {
  // 1. Ambil ulasan yang tidak disembunyikan untuk menu toko ini.
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT r.id, r.menu_id, m.name AS menu_name, u.full_name AS customer_name, r.rating, r.comment, r.created_at
     FROM reviews r JOIN menus m ON m.id = r.menu_id JOIN users u ON u.id = r.customer_id
     WHERE m.merchant_id = ? AND r.hidden_at IS NULL ORDER BY r.created_at DESC, r.id DESC`,
    [await getMerchantId(userId)],
  );
  // 2. Kirim kolom yang dipakai web saja.
  return rows.map((row) => ({
    id: row.id,
    menu_id: row.menu_id,
    menu_name: row.menu_name,
    customer_name: row.customer_name,
    rating: row.rating,
    comment: row.comment,
    created_at: row.created_at,
  }));
}
