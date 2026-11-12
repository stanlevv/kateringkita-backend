import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { hariIniWib } from "./merchant-kuota.service";
import { menuId, menuTidakAda } from "./merchant-menu.service";
import {
  DARI, DARI_TOKO, JOIN_FAVORIT, JOIN_FAVORIT_TOKO, KOLOM_KARTU, KOLOM_TOKO, TAMPIL, TOKO_TAMPIL, jam, kartu, profilPublik, titikTemuToko,
  tokoId, tokoTidakAda,
} from "./katalog.service";
import { Halaman } from "../dto/katalog.dto";

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

// F05 favorit toko ("Dapur Favorit"), padanan favorit menu (C-19). Sama dengan D13: baris milik toko yang tersembunyi
// (tidak lolos TOKO_TAMPIL) tidak dihapus, hanya tidak tampil; muncul lagi bila toko tampil lagi.

export async function simpanFavoritToko(userId: number, idRaw: unknown): Promise<void> {
  const id = tokoId(idRaw);
  const [ada] = await db.query<RowDataPacket[]>(`SELECT m.id FROM ${DARI_TOKO} WHERE m.id = ? AND ${TOKO_TAMPIL}`, [id]);
  if (!ada[0]) throw tokoTidakAda();
  await db.query("INSERT IGNORE INTO merchant_favorites (user_id, merchant_id) VALUES (?, ?)", [userId, id]);
}

export async function hapusFavoritToko(userId: number, idRaw: unknown): Promise<void> {
  await db.query("DELETE FROM merchant_favorites WHERE user_id = ? AND merchant_id = ?", [userId, tokoId(idRaw)]);
}

// TOKO_TAMPIL tanpa jam buka: toko tutup tetap ada (D3); 1 kueri data + 1 COUNT + 1 titik temu semua toko di halaman
export async function daftarFavoritToko(userId: number, h: Halaman) {
  const ms = jam.sekarang();
  const syarat = `mf.user_id IS NOT NULL AND ${TOKO_TAMPIL}`;
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${KOLOM_TOKO} FROM ${DARI_TOKO} ${JOIN_FAVORIT_TOKO} WHERE ${syarat}
     ORDER BY mf.created_at DESC, m.id DESC LIMIT ? OFFSET ?`,
    [userId, h.limit, (h.page - 1) * h.limit],
  );
  const [c] = await db.query<RowDataPacket[]>(`SELECT COUNT(*) AS total FROM ${DARI_TOKO} ${JOIN_FAVORIT_TOKO} WHERE ${syarat}`, [userId]);
  const titik = await titikTemuToko(rows.map((m) => m.id));
  return {
    data: rows.map((m) => profilPublik(m, ms, titik.get(m.id) ?? [])),
    meta: { page: h.page, limit: h.limit, total: Number(c[0].total) },
  };
}
