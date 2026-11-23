import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { hariIniWib } from "./merchant-kuota.service";
import { menuId, menuTidakAda } from "./merchant-menu.service";
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

// Favorit pembeli (C-19, D13). Baris favorit menu yang tersembunyi tidak dihapus: muncul lagi bila menu/toko aktif lagi.

export async function saveFavorite(userId: number, rawId: unknown): Promise<void> {
  const id = menuId(rawId);
  const [existingMenus] = await db.query<RowDataPacket[]>(
    `SELECT x.id FROM ${MENU_FROM} WHERE x.id = ? AND ${MENU_VISIBLE}`,
    [id],
  );
  if (!existingMenus[0]) throw menuTidakAda();
  await db.query("INSERT IGNORE INTO favorites (user_id, menu_id) VALUES (?, ?)", [userId, id]);
}

export async function deleteFavorite(userId: number, rawId: unknown): Promise<void> {
  await db.query("DELETE FROM favorites WHERE user_id = ? AND menu_id = ?", [userId, menuId(rawId)]);
}

// MENU_VISIBLE tanpa MERCHANT_OPEN: toko tutup & menu habis tetap ada (D3); 1 kueri data + 1 COUNT
export async function listFavorites(userId: number, pagination: Pagination) {
  const nowMs = clock.now();
  const whereClause = `f.user_id IS NOT NULL AND ${MENU_VISIBLE}`;
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${MENU_CARD_COLUMNS} FROM ${MENU_FROM} ${JOIN_FAVORITE} WHERE ${whereClause}
     ORDER BY f.created_at DESC, x.id DESC LIMIT ? OFFSET ?`,
    [hariIniWib(new Date(nowMs)), userId, pagination.limit, (pagination.page - 1) * pagination.limit],
  );
  const [countRows] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total FROM ${MENU_FROM} ${JOIN_FAVORITE} WHERE ${whereClause}`,
    [userId],
  );
  return {
    data: rows.map((row) => mapMenuCard(row, nowMs)),
    meta: { page: pagination.page, limit: pagination.limit, total: Number(countRows[0].total) },
  };
}

// F05 favorit toko ("Dapur Favorit"), padanan favorit menu (C-19). Sama dengan D13: baris milik toko yang tersembunyi
// (tidak lolos MERCHANT_VISIBLE) tidak dihapus, hanya tidak tampil; muncul lagi bila toko tampil lagi.

export async function saveFavoriteMerchant(userId: number, rawId: unknown): Promise<void> {
  const id = parseMerchantId(rawId);
  const [existingMerchants] = await db.query<RowDataPacket[]>(
    `SELECT m.id FROM ${MERCHANT_FROM} WHERE m.id = ? AND ${MERCHANT_VISIBLE}`,
    [id],
  );
  if (!existingMerchants[0]) throw merchantNotFound();
  await db.query("INSERT IGNORE INTO merchant_favorites (user_id, merchant_id) VALUES (?, ?)", [userId, id]);
}

export async function deleteFavoriteMerchant(userId: number, rawId: unknown): Promise<void> {
  await db.query("DELETE FROM merchant_favorites WHERE user_id = ? AND merchant_id = ?", [
    userId,
    parseMerchantId(rawId),
  ]);
}

// MERCHANT_VISIBLE tanpa jam buka: toko tutup tetap ada (D3); 1 kueri data + 1 COUNT + 1 titik temu semua toko di halaman
export async function listFavoriteMerchants(userId: number, pagination: Pagination) {
  const nowMs = clock.now();
  const whereClause = `mf.user_id IS NOT NULL AND ${MERCHANT_VISIBLE}`;
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${MERCHANT_COLUMNS} FROM ${MERCHANT_FROM} ${JOIN_FAVORITE_MERCHANT} WHERE ${whereClause}
     ORDER BY mf.created_at DESC, m.id DESC LIMIT ? OFFSET ?`,
    [userId, pagination.limit, (pagination.page - 1) * pagination.limit],
  );
  const [countRows] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total FROM ${MERCHANT_FROM} ${JOIN_FAVORITE_MERCHANT} WHERE ${whereClause}`,
    [userId],
  );
  const pickupPointsByMerchant = await getMerchantPickupPoints(rows.map((merchant) => merchant.id));
  return {
    data: rows.map((merchant) =>
      mapPublicMerchantProfile(merchant, nowMs, pickupPointsByMerchant.get(merchant.id) ?? []),
    ),
    meta: { page: pagination.page, limit: pagination.limit, total: Number(countRows[0].total) },
  };
}
