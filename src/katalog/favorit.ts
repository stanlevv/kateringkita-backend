import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { hariIniWib } from "../merchant/kuota";
import { menuId, menuTidakAda } from "../merchant/menus";
import { DARI, JOIN_FAVORIT, KOLOM_KARTU, TAMPIL, jam, kartu } from "./menus";
import { Halaman } from "./schemas";

// Favorit pembeli (C-19, D13). Baris favorit menu yang tersembunyi tidak dihapus: muncul lagi bila menu/toko aktif lagi.

export async function simpanFavorit(userId: number, idRaw: unknown): Promise<void> {
  const id = menuId(idRaw);
  const [ada] = await db.query<RowDataPacket[]>(`SELECT x.id FROM ${DARI} WHERE x.id = ? AND ${TAMPIL}`, [id]);
  if (!ada[0]) throw menuTidakAda();
  await db.query("INSERT IGNORE INTO favorites (user_id, menu_id) VALUES (?, ?)", [userId, id]);
}

export async function hapusFavorit(userId: number, idRaw: unknown): Promise<void> {
  await db.query("DELETE FROM favorites WHERE user_id = ? AND menu_id = ?", [userId, menuId(idRaw)]);
}

// TAMPIL tanpa BUKA: toko tutup & menu habis tetap ada (D3); 1 kueri data + 1 COUNT
export async function daftarFavorit(userId: number, h: Halaman) {
  const ms = jam.sekarang();
  const syarat = `f.user_id IS NOT NULL AND ${TAMPIL}`;
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${KOLOM_KARTU} FROM ${DARI} ${JOIN_FAVORIT} WHERE ${syarat}
     ORDER BY f.created_at DESC, x.id DESC LIMIT ? OFFSET ?`,
    [hariIniWib(new Date(ms)), userId, h.limit, (h.page - 1) * h.limit],
  );
  const [c] = await db.query<RowDataPacket[]>(`SELECT COUNT(*) AS total FROM ${DARI} ${JOIN_FAVORIT} WHERE ${syarat}`, [userId]);
  return { data: rows.map((r) => kartu(r, ms)), meta: { page: h.page, limit: h.limit, total: Number(c[0].total) } };
}
