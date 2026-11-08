import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { UlasanInput } from "../dto/pesanan.dto";
import { AppError } from "../utils/errors";
import { Conn, dalamTransaksi } from "./admin-audit.service";
import { idToko } from "./merchant-menu.service";

// F13 ulasan: pembeli mengulas menu dari pesanan completed miliknya; satu ulasan per (pesanan, menu).

/** Hitung ulang rating menu & toko dari tabel reviews (dipakai juga moderasi F19). */
export async function hitungUlangRating(conn: Pick<Conn, "query">, menuIds: number[], merchantId: number) {
  if (menuIds.length) {
    await conn.query(
      `UPDATE menus m SET rating_avg = (SELECT COALESCE(AVG(r.rating), 0) FROM reviews r WHERE r.menu_id = m.id AND r.hidden_at IS NULL),
         rating_count = (SELECT COUNT(*) FROM reviews r WHERE r.menu_id = m.id AND r.hidden_at IS NULL), updated_at = updated_at
       WHERE m.id IN (?)`,
      [menuIds],
    );
  }
  await conn.query(
    `UPDATE merchants t SET
       rating_avg = (SELECT COALESCE(AVG(r.rating), 0) FROM reviews r JOIN menus m ON m.id = r.menu_id WHERE m.merchant_id = t.id AND r.hidden_at IS NULL),
       rating_count = (SELECT COUNT(*) FROM reviews r JOIN menus m ON m.id = r.menu_id WHERE m.merchant_id = t.id AND r.hidden_at IS NULL)
     WHERE t.id = ?`,
    [merchantId],
  );
}

export async function kirimUlasan(userId: number, code: string, data: UlasanInput) {
  return dalamTransaksi(async (conn) => {
    const [[o]] = await conn.query<RowDataPacket[]>(
      "SELECT id, merchant_id, status FROM orders WHERE code = ? AND customer_id = ? FOR UPDATE", [code, userId],
    );
    if (!o) throw new AppError(404, "NOT_FOUND", "Pesanan tidak ditemukan.");
    if (o.status !== "completed") throw new AppError(409, "CONFLICT", "Ulasan hanya bisa untuk pesanan yang sudah selesai.");
    const [items] = await conn.query<RowDataPacket[]>(
      `SELECT DISTINCT i.menu_id, r.id AS sudah FROM order_items i LEFT JOIN reviews r ON r.order_id = i.order_id AND r.menu_id = i.menu_id
       WHERE i.order_id = ?`,
      [o.id],
    );
    const peta = new Map(items.map((i) => [i.menu_id as number, Boolean(i.sudah)]));
    const f: Record<string, string[]> = {};
    const dilihat = new Set<number>();
    data.items.forEach((it, i) => {
      if (!peta.has(it.menu_id)) f[`items.${i}.menu_id`] = ["Menu tidak ada di pesanan ini."];
      else if (peta.get(it.menu_id) || dilihat.has(it.menu_id)) f[`items.${i}.menu_id`] = ["Menu ini sudah diulas."];
      dilihat.add(it.menu_id);
    });
    if (Object.keys(f).length) throw new AppError(409, "CONFLICT", "Sebagian menu sudah diulas atau tidak ada di pesanan ini.", f);
    await conn.query("INSERT INTO reviews (order_id, menu_id, customer_id, rating, comment) VALUES ?",
      [data.items.map((it) => [o.id, it.menu_id, userId, it.rating, it.comment])]);
    await hitungUlangRating(conn, data.items.map((it) => it.menu_id), o.merchant_id);
    return { order_code: code, reviewed_menu_ids: data.items.map((it) => it.menu_id) };
  });
}

// Review di fe/types/review.ts; nama asli (disamarkan fe), ulasan disembunyikan admin tidak ikut.
// shortcut: tanpa paginasi (fe menyaring & memotong 10 per halaman); upgrade bila satu toko > beberapa ribu ulasan
export async function daftarUlasanToko(userId: number) {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT r.id, r.menu_id, m.name AS menu_name, u.full_name AS customer_name, r.rating, r.comment, r.created_at
     FROM reviews r JOIN menus m ON m.id = r.menu_id JOIN users u ON u.id = r.customer_id
     WHERE m.merchant_id = ? AND r.hidden_at IS NULL ORDER BY r.created_at DESC, r.id DESC`,
    [await idToko(userId)],
  );
  return rows.map((r) => ({
    id: r.id, menu_id: r.menu_id, menu_name: r.menu_name, customer_name: r.customer_name, rating: r.rating, comment: r.comment, created_at: r.created_at,
  }));
}
