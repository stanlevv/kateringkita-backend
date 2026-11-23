// Isi file: menu favorit dan toko favorit ("Dapur Favorit") milik pembeli: simpan, hapus, dan daftar. Alurnya
// routes/catalog.ts → handlers/catalog.handler.ts → file ini → database. Favorit yang menu atau tokonya sedang
// disembunyikan tidak dihapus, hanya tidak tampil, dan muncul lagi saat menu atau tokonya tampil lagi.
import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { getWibDate } from "./merchant-quota.service";
import { parseMenuId, menuNotFound } from "./merchant-menu.service";
import {
  MENU_FROM,
  MERCHANT_FROM,
  JOIN_FAVORITE,
  JOIN_FAVORITE_MERCHANT,
  MENU_CARD_COLUMNS,
  MERCHANT_COLUMNS,
  MENU_VISIBLE,
  MERCHANT_VISIBLE,
  clock,
  mapMenuCard,
  mapPublicMerchantProfile,
  getMerchantPickupPoints,
  parseMerchantId,
  merchantNotFound,
} from "./catalog.service";
import { Pagination } from "../dto/catalog.dto";

// Istilah: `INSERT IGNORE` = sisipkan baris, tetapi bila baris yang sama sudah ada, lewati tanpa galat. Jadi menyimpan
// favorit yang sudah tersimpan tetap berhasil. Paginasi dan LEFT JOIN favorit dijelaskan di catalog.service.

/**
 * Menyimpan satu menu ke favorit pembeli. Menyimpan dua kali tidak membuat baris ganda.
 * @param userId id pembeli yang login
 * @param rawId  id menu dari path URL, belum dicek
 * @returns tidak ada
 * @throws 404 NOT_FOUND bila id tidak valid atau menu tidak tampil di katalog
 */
export async function saveFavorite(userId: number, rawId: unknown): Promise<void> {
  const id = parseMenuId(rawId);
  const [existingMenus] = await db.query<RowDataPacket[]>(
    `SELECT x.id FROM ${MENU_FROM} WHERE x.id = ? AND ${MENU_VISIBLE}`,
    [id],
  );
  if (!existingMenus[0]) throw menuNotFound();
  await db.query("INSERT IGNORE INTO favorites (user_id, menu_id) VALUES (?, ?)", [userId, id]);
}

/**
 * Menghapus satu menu dari favorit pembeli. Menghapus menu yang tidak ada di favorit tidak dianggap galat.
 * @param userId id pembeli yang login
 * @param rawId  id menu dari path URL, belum dicek
 * @returns tidak ada
 * @throws 404 NOT_FOUND bila id bukan bilangan bulat positif
 */
export async function deleteFavorite(userId: number, rawId: unknown): Promise<void> {
  await db.query("DELETE FROM favorites WHERE user_id = ? AND menu_id = ?", [userId, parseMenuId(rawId)]);
}

/**
 * Daftar menu favorit pembeli per halaman, terbaru disimpan dulu. Menu dari toko yang sedang tutup dan menu yang habis
 * tetap tampil; yang tidak tampil hanya menu atau toko yang disembunyikan.
 * @param userId     id pembeli yang login
 * @param pagination nomor halaman dan jumlah baris per halaman
 * @returns `{ data, meta }`: kartu menu dan `{ page, limit, total }`
 */
export async function listFavorites(userId: number, pagination: Pagination) {
  const nowMs = clock.now();
  // 1. `f.user_id IS NOT NULL` menyisakan menu yang ada di favorit pembeli ini saja.
  const whereClause = `f.user_id IS NOT NULL AND ${MENU_VISIBLE}`;
  // 2. Ambil satu halaman. Parameter: tanggal WIB hari ini (sisa porsi), id pembeli, limit, offset.
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${MENU_CARD_COLUMNS} FROM ${MENU_FROM} ${JOIN_FAVORITE} WHERE ${whereClause}
     ORDER BY f.created_at DESC, x.id DESC LIMIT ? OFFSET ?`,
    [getWibDate(new Date(nowMs)), userId, pagination.limit, (pagination.page - 1) * pagination.limit],
  );
  // 3. Hitung total favorit yang tampil untuk paginasi.
  const [countRows] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total FROM ${MENU_FROM} ${JOIN_FAVORITE} WHERE ${whereClause}`,
    [userId],
  );
  return {
    data: rows.map((row) => mapMenuCard(row, nowMs)),
    meta: { page: pagination.page, limit: pagination.limit, total: Number(countRows[0].total) },
  };
}

/**
 * Menyimpan satu toko ke toko favorit pembeli. Menyimpan dua kali tidak membuat baris ganda.
 * @param userId id pembeli yang login
 * @param rawId  id toko dari path URL, belum dicek
 * @returns tidak ada
 * @throws 404 NOT_FOUND bila id tidak valid atau toko tidak tampil (belum terverifikasi atau pemiliknya nonaktif)
 */
export async function saveFavoriteMerchant(userId: number, rawId: unknown): Promise<void> {
  const id = parseMerchantId(rawId);
  const [existingMerchants] = await db.query<RowDataPacket[]>(
    `SELECT m.id FROM ${MERCHANT_FROM} WHERE m.id = ? AND ${MERCHANT_VISIBLE}`,
    [id],
  );
  if (!existingMerchants[0]) throw merchantNotFound();
  await db.query("INSERT IGNORE INTO merchant_favorites (user_id, merchant_id) VALUES (?, ?)", [userId, id]);
}

/**
 * Menghapus satu toko dari toko favorit pembeli. Menghapus toko yang tidak ada di favorit tidak dianggap galat.
 * @param userId id pembeli yang login
 * @param rawId  id toko dari path URL, belum dicek
 * @returns tidak ada
 * @throws 404 NOT_FOUND bila id bukan bilangan bulat positif
 */
export async function deleteFavoriteMerchant(userId: number, rawId: unknown): Promise<void> {
  await db.query("DELETE FROM merchant_favorites WHERE user_id = ? AND merchant_id = ?", [
    userId,
    parseMerchantId(rawId),
  ]);
}

/**
 * Daftar toko favorit pembeli per halaman, terbaru disimpan dulu. Toko yang sedang tutup tetap tampil. Memakai 3 kueri:
 * data, COUNT, dan titik temu semua toko di halaman ini sekaligus.
 * @param userId     id pembeli yang login
 * @param pagination nomor halaman dan jumlah baris per halaman
 * @returns `{ data, meta }`: profil toko publik dan `{ page, limit, total }`
 */
export async function listFavoriteMerchants(userId: number, pagination: Pagination) {
  const nowMs = clock.now();
  // 1. `mf.user_id IS NOT NULL` menyisakan toko yang ada di favorit pembeli ini saja.
  const whereClause = `mf.user_id IS NOT NULL AND ${MERCHANT_VISIBLE}`;
  // 2. Ambil satu halaman toko.
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${MERCHANT_COLUMNS} FROM ${MERCHANT_FROM} ${JOIN_FAVORITE_MERCHANT} WHERE ${whereClause}
     ORDER BY mf.created_at DESC, m.id DESC LIMIT ? OFFSET ?`,
    [userId, pagination.limit, (pagination.page - 1) * pagination.limit],
  );
  // 3. Hitung total toko favorit yang tampil untuk paginasi.
  const [countRows] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total FROM ${MERCHANT_FROM} ${JOIN_FAVORITE_MERCHANT} WHERE ${whereClause}`,
    [userId],
  );
  // 4. Ambil titik temu semua toko di halaman ini dalam satu kueri, lalu pasang ke profil masing-masing.
  const pickupPointsByMerchant = await getMerchantPickupPoints(rows.map((merchant) => merchant.id));
  return {
    data: rows.map((merchant) =>
      mapPublicMerchantProfile(merchant, nowMs, pickupPointsByMerchant.get(merchant.id) ?? []),
    ),
    meta: { page: pagination.page, limit: pagination.limit, total: Number(countRows[0].total) },
  };
}
