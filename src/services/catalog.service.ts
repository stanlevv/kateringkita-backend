import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { sedangBuka } from "./admin-summary.service";
import { AppError } from "../utils/errors";
import { hariIniWib } from "./merchant-kuota.service";
import { galeri, menuId, menuTidakAda } from "./merchant-menu.service";
import { Pagination, CatalogQuery } from "../dto/catalog.dto";
import { voucherToko } from "./voucher.service";

// Katalog publik (C-05, C-06). Hanya SELECT: tidak ada UPDATE/FOR UPDATE di modul ini (R-12).

export type MenuCard = {
  id: number;
  name: string;
  image_url: string | null;
  price: number;
  unit_label: string;
  category: { id: number; name: string; slug: string };
  merchant: { id: number; slug: string; business_name: string; is_open: boolean };
  available: number;
  badge: "sold_out" | "preorder" | "low_stock" | "available";
  rating_avg: number;
  rating_count: number;
  is_favorite: boolean;
};

// Satu sumber "sekarang" untuk jam buka & tanggal stok; test menggantinya agar tidak bergantung jam nyata
export const clock = { now: () => Date.now() };

// "HH:MM:00" WIB; detik dibuang agar sama persis dengan sedangBuka() yang membandingkan per menit
export const toWibTime = (timestampMs: number): string =>
  `${new Date(timestampMs + 7 * 3600e3).toISOString().slice(11, 16)}:00`;

// D1 (R-14, BE-11): menu aktif & belum terhapus, toko terverifikasi, pemilik aktif
export const MERCHANT_VISIBLE = "m.verification_status = 'verified' AND u.is_active";
export const MENU_VISIBLE = `x.is_active AND x.deleted_at IS NULL AND ${MERCHANT_VISIBLE}`;

// D2: saklar + jam WIB, sama dengan sedangBuka() (tepat jam tutup = tutup; buka > tutup = lewat tengah malam). 4 parameter jam.
export const MERCHANT_OPEN = `m.is_open AND (CASE WHEN m.open_time <= m.close_time THEN ? >= m.open_time AND ? < m.close_time
  ELSE ? >= m.open_time OR ? < m.close_time END)`;

// D5: proyeksi reset harian (aturan `<` sama dengan segarkanKuota) tanpa menulis; 1 parameter tanggal WIB
export const REMAINING_STOCK = `GREATEST(CASE WHEN x.stock_date IS NULL OR x.stock_date < ? THEN x.daily_quota
  ELSE x.quota_today - x.sold_today - x.held_today END, 0)`;

export const MENU_FROM = `menus x JOIN merchants m ON m.id = x.merchant_id JOIN users u ON u.id = m.user_id
  JOIN categories c ON c.id = x.category_id`;

// Kolom kartu + is_favorite; parameter: tanggal (REMAINING_STOCK), lalu userId (LEFT JOIN favorites; null = tidak pernah cocok)
export const MENU_CARD_COLUMNS = `x.id, x.name, x.image_url, x.price, x.unit_label, x.is_preorder, x.rating_avg, x.rating_count,
  c.id AS c_id, c.name AS c_name, c.slug AS c_slug, m.id AS m_id, m.slug AS m_slug, m.business_name, m.is_open, m.open_time, m.close_time,
  ${REMAINING_STOCK} AS available, f.user_id IS NOT NULL AS fav`;
export const JOIN_FAVORITE = "LEFT JOIN favorites f ON f.menu_id = x.id AND f.user_id = ?";

const badge = (available: number, preorder: boolean): MenuCard["badge"] =>
  available <= 0 ? "sold_out" : preorder ? "preorder" : available <= 10 ? "low_stock" : "available";

export const isMerchantOpen = (row: RowDataPacket, nowMs: number) =>
  Boolean(row.is_open) && sedangBuka(nowMs, String(row.open_time), String(row.close_time));

// Mapper publik D6: daftar kunci eksplisit, tidak pernah `...row` (R-11)
export function mapMenuCard(row: RowDataPacket, nowMs: number): MenuCard {
  const available = Number(row.available);
  return {
    id: row.id,
    name: row.name,
    image_url: row.image_url,
    price: row.price,
    unit_label: row.unit_label,
    category: { id: row.c_id, name: row.c_name, slug: row.c_slug },
    merchant: { id: row.m_id, slug: row.m_slug, business_name: row.business_name, is_open: isMerchantOpen(row, nowMs) },
    available,
    badge: badge(available, Boolean(row.is_preorder)),
    rating_avg: Number(row.rating_avg),
    rating_count: row.rating_count,
    is_favorite: Boolean(row.fav),
  };
}

const SORT_COLUMNS: Record<CatalogQuery["sort"], string> = {
  popular: "x.sold_total DESC",
  rating: "x.rating_avg DESC, x.rating_count DESC",
  price_asc: "x.price ASC",
  price_desc: "x.price DESC",
  newest: "x.id DESC",
};

// Daftar/pencarian: 1 kueri data + 1 COUNT (tanpa N+1)
export async function listCatalog(query: CatalogQuery, userId: number | null) {
  const nowMs = clock.now();
  const wibTime = toWibTime(nowMs);
  const today = hariIniWib(new Date(nowMs));
  // filter toko (halaman profil, D3) tetap menampilkan menu toko tutup; daftar/pencarian umum hanya toko buka (D2)
  const where = query.merchant ? [MENU_VISIBLE] : [MENU_VISIBLE, MERCHANT_OPEN];
  const args: unknown[] = query.merchant ? [] : [wibTime, wibTime, wibTime, wibTime];
  if (query.q) {
    // shortcut: pencarian LIKE memindai semua menu tampil; ganti FULLTEXT/indeks bila menu > 10.000 atau p95 > 300 ms
    const searchPattern = `%${query.q.replace(/[\\%_]/g, "\\$&")}%`;
    where.push("(LOWER(x.name) LIKE LOWER(?) OR LOWER(m.business_name) LIKE LOWER(?))");
    args.push(searchPattern, searchPattern);
  }
  if (query.category) {
    where.push("c.slug = ?");
    args.push(query.category);
  }
  if (query.merchant) {
    where.push("m.slug = ?");
    args.push(query.merchant);
  }
  if (query.pickup_point_id) {
    where.push(`EXISTS (SELECT 1 FROM merchant_pickup_points mp JOIN pickup_points p ON p.id = mp.pickup_point_id
      WHERE mp.merchant_id = m.id AND p.id = ? AND p.is_active)`);
    args.push(query.pickup_point_id);
  }
  const whereClause = where.join(" AND ");
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${MENU_CARD_COLUMNS} FROM ${MENU_FROM} ${JOIN_FAVORITE} WHERE ${whereClause}
     ORDER BY ${REMAINING_STOCK} <= 0, ${SORT_COLUMNS[query.sort]}, x.id DESC LIMIT ? OFFSET ?`,
    [today, userId, ...args, today, query.limit, (query.page - 1) * query.limit],
  );
  const [countRows] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total FROM ${MENU_FROM} WHERE ${whereClause}`,
    args,
  );
  return {
    data: rows.map((row) => mapMenuCard(row, nowMs)),
    meta: { page: query.page, limit: query.limit, total: Number(countRows[0].total) },
  };
}

const toHourMinute = (time: unknown) => String(time).slice(0, 5);

export type PickupPoint = { id: number; name: string; description: string | null };

// Titik temu aktif beberapa toko dalam 1 kueri (tanpa N+1 di daftar favorit toko); toko tanpa titik temu → []
export async function getMerchantPickupPoints(merchantIds: number[]): Promise<Map<number, PickupPoint[]>> {
  const pickupPointsByMerchant = new Map<number, PickupPoint[]>(merchantIds.map((id) => [id, []]));
  if (!merchantIds.length) return pickupPointsByMerchant;
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT mp.merchant_id, p.id, p.name, p.description FROM merchant_pickup_points mp JOIN pickup_points p ON p.id = mp.pickup_point_id
     WHERE mp.merchant_id IN (?) AND p.is_active ORDER BY p.name`,
    [merchantIds],
  );
  for (const row of rows)
    pickupPointsByMerchant.get(row.merchant_id)?.push({ id: row.id, name: row.name, description: row.description });
  return pickupPointsByMerchant;
}

export const getPickupPoints = async (merchantId: number): Promise<PickupPoint[]> =>
  (await getMerchantPickupPoints([merchantId])).get(merchantId) ?? [];

// D7: MENU_VISIBLE tanpa MERCHANT_OPEN (toko tutup tetap 200, D3); 3 kueri: menu, opsi aktif, titik temu
export async function getMenuDetail(rawId: unknown, userId: number | null) {
  const id = menuId(rawId);
  const nowMs = clock.now();
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${MENU_CARD_COLUMNS}, x.description, x.min_order_qty, x.prep_minutes, x.preorder_days, x.gallery, m.logo_url
     FROM ${MENU_FROM} ${JOIN_FAVORITE} WHERE x.id = ? AND ${MENU_VISIBLE}`,
    [hariIniWib(new Date(nowMs)), userId, id],
  );
  const row = rows[0];
  if (!row) throw menuTidakAda();
  const [[options], pickupPoints] = await Promise.all([
    db.query<RowDataPacket[]>(
      "SELECT id, name, extra_price FROM menu_options WHERE menu_id = ? AND is_active ORDER BY id",
      [id],
    ),
    getPickupPoints(row.m_id),
  ]);
  const card = mapMenuCard(row, nowMs);
  return {
    ...card,
    description: row.description,
    gallery: galeri(row.gallery),
    options: options.map((option) => ({ id: option.id, name: option.name, extra_price: option.extra_price })),
    min_order_qty: row.min_order_qty,
    prep_minutes: row.prep_minutes,
    is_preorder: Boolean(row.is_preorder),
    preorder_days: row.preorder_days,
    merchant: {
      ...card.merchant,
      logo_url: row.logo_url,
      open_time: toHourMinute(row.open_time),
      close_time: toHourMinute(row.close_time),
      pickup_points: pickupPoints,
    },
  };
}

// D11: menu harus lolos MENU_VISIBLE; nama pembeli disamarkan 2 karakter + "***"
export async function listMenuReviews(rawId: unknown, pagination: Pagination) {
  const id = menuId(rawId);
  const [existingMenus] = await db.query<RowDataPacket[]>(
    `SELECT x.id FROM ${MENU_FROM} WHERE x.id = ? AND ${MENU_VISIBLE}`,
    [id],
  );
  if (!existingMenus[0]) throw menuTidakAda();
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT r.rating, r.comment, u.full_name, r.created_at FROM reviews r JOIN users u ON u.id = r.customer_id
     WHERE r.menu_id = ? AND r.hidden_at IS NULL ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`,
    [id, pagination.limit, (pagination.page - 1) * pagination.limit],
  );
  // F19: ulasan yang disembunyikan admin tidak tampil
  const [countRows] = await db.query<RowDataPacket[]>(
    "SELECT COUNT(*) AS total FROM reviews WHERE menu_id = ? AND hidden_at IS NULL",
    [id],
  );
  return {
    data: rows.map((review) => ({
      rating: review.rating,
      comment: review.comment,
      customer_name: `${Array.from(String(review.full_name).trim()).slice(0, 2).join("")}***`,
      created_at: review.created_at,
    })),
    meta: { page: pagination.page, limit: pagination.limit, total: Number(countRows[0].total) },
  };
}

export const merchantNotFound = () => new AppError(404, "NOT_FOUND", "Toko tidak ditemukan.");

// id path toko bukan bilangan bulat positif diperlakukan sama dengan toko yang tidak ada (seperti menuId, BE-01)
export const parseMerchantId = (rawId: unknown): number => {
  const text = String(rawId);
  if (!/^[1-9]\d{0,9}$/.test(text)) throw merchantNotFound();
  return Number(text);
};

export const MERCHANT_FROM =
  "merchants m JOIN users u ON u.id = m.user_id JOIN merchant_types t ON t.id = m.merchant_type_id";

// Kolom profil toko + is_favorite; parameter: userId (LEFT JOIN merchant_favorites; null = tidak pernah cocok, D14)
export const MERCHANT_COLUMNS = `m.id, m.slug, m.business_name, m.description, m.logo_url, m.cover_url, m.is_open, m.open_time, m.close_time, m.rating_avg,
  m.rating_count, t.id AS t_id, t.name AS t_name, mf.user_id IS NOT NULL AS fav`;
export const JOIN_FAVORITE_MERCHANT = "LEFT JOIN merchant_favorites mf ON mf.merchant_id = m.id AND mf.user_id = ?";

// Mapper publik D12 (tanpa alamat, WA, user_id, status verifikasi): daftar kunci eksplisit (R-11).
// Satu bentuk untuk GET /merchants/:slug dan kartu favorit toko.
export function mapPublicMerchantProfile(merchant: RowDataPacket, nowMs: number, pickupPoints: PickupPoint[]) {
  return {
    id: merchant.id,
    slug: merchant.slug,
    business_name: merchant.business_name,
    description: merchant.description,
    logo_url: merchant.logo_url,
    cover_url: merchant.cover_url,
    merchant_type: { id: merchant.t_id, name: merchant.t_name },
    is_open: isMerchantOpen(merchant, nowMs),
    open_time: toHourMinute(merchant.open_time),
    close_time: toHourMinute(merchant.close_time),
    rating_avg: Number(merchant.rating_avg),
    rating_count: merchant.rating_count,
    pickup_points: pickupPoints,
    is_favorite: Boolean(merchant.fav),
  };
}

// D12; 2 kueri
export async function getMerchantProfile(slug: string, userId: number | null) {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${MERCHANT_COLUMNS} FROM ${MERCHANT_FROM} ${JOIN_FAVORITE_MERCHANT} WHERE m.slug = ? AND ${MERCHANT_VISIBLE}`,
    [userId, slug],
  );
  const merchant = rows[0];
  if (!merchant) throw merchantNotFound();
  const nowMs = clock.now();
  // voucher toko publik (rancangan voucher 2026-11-16); claimed hanya untuk pembeli login
  return {
    ...mapPublicMerchantProfile(merchant, nowMs, await getPickupPoints(merchant.id)),
    vouchers: await voucherToko(merchant.id, userId, nowMs),
  };
}
