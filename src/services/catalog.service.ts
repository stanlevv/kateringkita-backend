// Isi file: katalog publik, yaitu daftar dan pencarian menu, detail menu, ulasan menu, dan profil toko. Alurnya
// routes/catalog.ts → handlers/catalog.handler.ts → file ini → database. Potongan SQL dan pemeta (mapper) di sini juga
// dipakai service lain, antara lain favorit, rekomendasi, meja (table), dan pesanan. File ini hanya membaca (SELECT).
import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { sedangBuka } from "./admin-summary.service";
import { AppError } from "../utils/errors";
import { getWibDate } from "./merchant-quota.service";
import { parseGallery, parseMenuId, menuNotFound } from "./merchant-menu.service";
import { Pagination, CatalogQuery } from "../dto/catalog.dto";
import { listMerchantVouchers } from "./voucher.service";

// Istilah yang dipakai di file ini:
// - WIB: jam Indonesia barat (UTC+7). Jam buka toko dan tanggal stok harian dihitung menurut WIB, bukan jam server.
// - Alias SQL: nama pendek tabel di dalam kueri. `x` = menus, `m` = merchants, `u` = users (pemilik toko),
//   `c` = categories, `f` = favorites, `mf` = merchant_favorites, `t` = merchant_types, `p` = pickup_points.
// - Paginasi: daftar dibagi per halaman. `limit` = jumlah baris per halaman, `OFFSET (page - 1) * limit` = jumlah baris
//   yang dilewati sebelum halaman yang diminta. Kueri COUNT terpisah memberi `total` agar aplikasi tahu jumlah halaman.

/** Bentuk kartu menu yang dikirim ke aplikasi pada daftar katalog, favorit, rekomendasi, dan menu meja. */
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

/**
 * Satu-satunya sumber "waktu sekarang" untuk jam buka toko dan tanggal stok. Ditaruh di dalam objek supaya test bisa
 * mengganti `clock.now` dan membekukan waktu, sehingga hasil test tidak bergantung pada jam nyata.
 */
export const clock = { now: () => Date.now() };

/**
 * Mengubah waktu menjadi jam WIB berbentuk `HH:MM:00`. Detik selalu `00` supaya perbandingannya per menit, sama dengan
 * `sedangBuka()`.
 * @param timestampMs waktu dalam milidetik sejak 1 Januari 1970 UTC
 * @returns jam WIB, contoh `"10:05:00"`
 */
export const toWibTime = (timestampMs: number): string =>
  `${new Date(timestampMs + 7 * 3600e3).toISOString().slice(11, 16)}:00`;

/** Syarat SQL toko tampil di katalog: toko sudah diverifikasi admin dan akun pemiliknya aktif. Alias `m` dan `u`. */
export const MERCHANT_VISIBLE = "m.verification_status = 'verified' AND u.is_active";
/** Syarat SQL menu tampil: menu aktif, belum dihapus, dan tokonya lolos {@link MERCHANT_VISIBLE}. */
export const MENU_VISIBLE = `x.is_active AND x.deleted_at IS NULL AND ${MERCHANT_VISIBLE}`;

/**
 * Syarat SQL toko sedang buka: saklar buka toko menyala dan jam WIB sekarang ada di dalam jam bukanya. Aturannya sama
 * dengan `sedangBuka()`: tepat di jam tutup dianggap sudah tutup. Bila jam buka lebih besar dari jam tutup (contoh
 * 18:00–02:00), jam buka melewati tengah malam, jadi toko buka bila sekarang ≥ jam buka atau sekarang < jam tutup.
 * Butuh 4 parameter, keempatnya jam WIB sekarang dari {@link toWibTime}.
 */
export const MERCHANT_OPEN = `m.is_open AND (CASE WHEN m.open_time <= m.close_time THEN ? >= m.open_time AND ? < m.close_time
  ELSE ? >= m.open_time OR ? < m.close_time END)`;

/**
 * Ekspresi SQL sisa porsi menu hari ini, tanpa menulis ke database. Bila stok terakhir dicatat untuk hari sebelum hari
 * ini (atau belum pernah), kuota dianggap sudah kembali penuh (`daily_quota`), sama dengan aturan `refreshDailyQuota`
 * yang baru benar-benar mengatur ulang angka di database saat ada pesanan. Bila tidak, sisa = kuota hari ini −
 * terjual − ditahan pesanan yang menunggu. Hasil tidak pernah di bawah 0. Butuh 1 parameter: tanggal WIB hari ini
 * (`YYYY-MM-DD`).
 */
export const REMAINING_STOCK = `GREATEST(CASE WHEN x.stock_date IS NULL OR x.stock_date < ? THEN x.daily_quota
  ELSE x.quota_today - x.sold_today - x.held_today END, 0)`;

/** Bagian FROM SQL untuk kueri menu: menu beserta toko, pemilik toko, dan kategorinya. */
export const MENU_FROM = `menus x JOIN merchants m ON m.id = x.merchant_id JOIN users u ON u.id = m.user_id
  JOIN categories c ON c.id = x.category_id`;

/**
 * Kolom SQL untuk {@link mapMenuCard}, termasuk sisa porsi dan `fav` (menu ini favorit pembeli atau bukan). Dipakai
 * bersama {@link JOIN_FAVORITE}, jadi urutan parameternya: tanggal WIB hari ini (untuk sisa porsi), lalu id pembeli.
 */
export const MENU_CARD_COLUMNS = `x.id, x.name, x.image_url, x.price, x.unit_label, x.is_preorder, x.rating_avg, x.rating_count,
  c.id AS c_id, c.name AS c_name, c.slug AS c_slug, m.id AS m_id, m.slug AS m_slug, m.business_name, m.is_open, m.open_time, m.close_time,
  ${REMAINING_STOCK} AS available, f.user_id IS NOT NULL AS fav`;
/**
 * Sambungan SQL ke tabel favorit milik satu pembeli. LEFT JOIN berarti semua menu tetap ikut walaupun tidak ada baris
 * favorit yang cocok; untuk menu itu kolom `f.user_id` berisi NULL. Bila id pembeli null (tamu), `f.user_id = NULL`
 * tidak pernah benar, jadi semua menu dianggap bukan favorit. Butuh 1 parameter: id pembeli atau null.
 */
export const JOIN_FAVORITE = "LEFT JOIN favorites f ON f.menu_id = x.id AND f.user_id = ?";

// Label kartu: habis bila sisa ≤ 0, lalu pre-order, lalu "stok sedikit" bila sisa ≤ 10, selain itu tersedia.
const badge = (available: number, preorder: boolean): MenuCard["badge"] =>
  available <= 0 ? "sold_out" : preorder ? "preorder" : available <= 10 ? "low_stock" : "available";

/**
 * Mengecek apakah toko sedang buka: saklar buka menyala dan waktu sekarang di dalam jam buka (aturan `sedangBuka()`,
 * sama dengan {@link MERCHANT_OPEN} di SQL).
 * @param row   baris database berisi `is_open`, `open_time`, dan `close_time` toko
 * @param nowMs waktu sekarang dalam milidetik (dari {@link clock})
 * @returns true bila toko sedang buka
 */
export const isMerchantOpen = (row: RowDataPacket, nowMs: number) =>
  Boolean(row.is_open) && sedangBuka(nowMs, String(row.open_time), String(row.close_time));

/**
 * Mengubah satu baris hasil {@link MENU_CARD_COLUMNS} menjadi kartu menu publik. Kunci ditulis satu per satu (tidak
 * menyalin seluruh baris), supaya kolom yang tidak boleh keluar tidak ikut terkirim.
 * @param row   baris database dari kueri yang memakai {@link MENU_CARD_COLUMNS}
 * @param nowMs waktu sekarang dalam milidetik, untuk status buka toko
 * @returns kartu menu
 */
export function mapMenuCard(row: RowDataPacket, nowMs: number): MenuCard {
  // 1. Sisa porsi diubah ke angka sekali, karena dipakai untuk `available` dan untuk label kartu.
  const available = Number(row.available);
  // 2. Susun kartu; status buka toko dihitung dari waktu sekarang.
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

// Pilihan urutan katalog → isi ORDER BY.
const SORT_COLUMNS: Record<CatalogQuery["sort"], string> = {
  popular: "x.sold_total DESC",
  rating: "x.rating_avg DESC, x.rating_count DESC",
  price_asc: "x.price ASC",
  price_desc: "x.price DESC",
  newest: "x.id DESC",
};

/**
 * Daftar dan pencarian menu katalog per halaman. Tanpa filter toko, hanya menu dari toko yang sedang buka yang tampil.
 * Dengan filter toko (halaman profil toko), menu tetap tampil walaupun tokonya tutup. Menu habis selalu di urutan
 * paling bawah. Cukup 2 kueri: satu untuk data, satu COUNT untuk total.
 * @param query  filter dan urutan dari query string: kata cari `q`, kategori, toko, titik temu, urutan, halaman
 * @param userId id pembeli yang login untuk tanda favorit, atau null untuk tamu dan peran lain
 * @returns `{ data, meta }`: kartu menu halaman ini dan `{ page, limit, total }`
 */
export async function listCatalog(query: CatalogQuery, userId: number | null) {
  const nowMs = clock.now();
  const wibTime = toWibTime(nowMs);
  const today = getWibDate(new Date(nowMs));
  // 1. Syarat dasar: menu tampil. Tanpa filter toko ditambah syarat toko sedang buka (4 parameter jam WIB).
  const where = query.merchant ? [MENU_VISIBLE] : [MENU_VISIBLE, MERCHANT_OPEN];
  const args: unknown[] = query.merchant ? [] : [wibTime, wibTime, wibTime, wibTime];
  if (query.q) {
    // 2. Kata cari dicocokkan ke nama menu atau nama toko. Tanda \ % _ diberi garis miring terbalik supaya dibaca
    //    sebagai huruf biasa, bukan tanda khusus LIKE.
    // shortcut: pencarian LIKE memindai semua menu tampil; ganti FULLTEXT/indeks bila menu > 10.000 atau p95 > 300 ms
    const searchPattern = `%${query.q.replace(/[\\%_]/g, "\\$&")}%`;
    where.push("(LOWER(x.name) LIKE LOWER(?) OR LOWER(m.business_name) LIKE LOWER(?))");
    args.push(searchPattern, searchPattern);
  }
  // 3. Filter tambahan: kategori, toko, dan titik temu aktif yang dilayani toko.
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
  // 4. Ambil satu halaman. Urutan parameter mengikuti urutan `?` di SQL: tanggal (kolom sisa), id pembeli (favorit),
  //    syarat WHERE, tanggal lagi (ORDER BY menu habis di bawah), lalu limit dan offset.
  const whereClause = where.join(" AND ");
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${MENU_CARD_COLUMNS} FROM ${MENU_FROM} ${JOIN_FAVORITE} WHERE ${whereClause}
     ORDER BY ${REMAINING_STOCK} <= 0, ${SORT_COLUMNS[query.sort]}, x.id DESC LIMIT ? OFFSET ?`,
    [today, userId, ...args, today, query.limit, (query.page - 1) * query.limit],
  );
  // 5. Hitung total baris dengan syarat yang sama untuk paginasi.
  const [countRows] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total FROM ${MENU_FROM} WHERE ${whereClause}`,
    args,
  );
  return {
    data: rows.map((row) => mapMenuCard(row, nowMs)),
    meta: { page: query.page, limit: query.limit, total: Number(countRows[0].total) },
  };
}

// Jam dari database ("HH:MM:SS") dipotong jadi "HH:MM".
const toHourMinute = (time: unknown) => String(time).slice(0, 5);

/** Titik temu (tempat ambil pesanan) yang ditampilkan ke pembeli. */
export type PickupPoint = { id: number; name: string; description: string | null };

/**
 * Mengambil titik temu aktif untuk beberapa toko sekaligus dalam satu kueri, supaya daftar toko tidak perlu satu kueri
 * per toko. Toko tanpa titik temu tetap ada di hasil dengan daftar kosong.
 * @param merchantIds id toko yang ingin diambil titik temunya
 * @returns peta id toko → daftar titik temu, urut nama
 */
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

/**
 * Mengambil titik temu aktif satu toko.
 * @param merchantId id toko
 * @returns daftar titik temu urut nama; kosong bila toko tidak punya titik temu aktif
 */
export const getPickupPoints = async (merchantId: number): Promise<PickupPoint[]> =>
  (await getMerchantPickupPoints([merchantId])).get(merchantId) ?? [];

/**
 * Detail satu menu untuk halaman menu. Menu harus lolos {@link MENU_VISIBLE}, tetapi tokonya boleh sedang tutup
 * (tetap 200 dengan `is_open` false). Memakai 3 kueri: menu, opsi tambahan yang aktif, dan titik temu toko.
 * @param rawId  id menu dari path URL, belum dicek
 * @param userId id pembeli yang login untuk tanda favorit, atau null
 * @returns kartu menu ditambah deskripsi, galeri foto, opsi, aturan pesan, dan data toko (logo, jam buka, titik temu)
 * @throws 404 NOT_FOUND bila id tidak valid atau menu tidak tampil
 */
export async function getMenuDetail(rawId: unknown, userId: number | null) {
  const id = parseMenuId(rawId);
  const nowMs = clock.now();
  // 1. Ambil menu beserta kolom kartu dan kolom detail.
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${MENU_CARD_COLUMNS}, x.description, x.min_order_qty, x.prep_minutes, x.preorder_days, x.gallery, m.logo_url
     FROM ${MENU_FROM} ${JOIN_FAVORITE} WHERE x.id = ? AND ${MENU_VISIBLE}`,
    [getWibDate(new Date(nowMs)), userId, id],
  );
  const row = rows[0];
  if (!row) throw menuNotFound();
  // 2. Ambil opsi tambahan yang aktif dan titik temu toko secara bersamaan.
  const [[options], pickupPoints] = await Promise.all([
    db.query<RowDataPacket[]>(
      "SELECT id, name, extra_price FROM menu_options WHERE menu_id = ? AND is_active ORDER BY id",
      [id],
    ),
    getPickupPoints(row.m_id),
  ]);
  // 3. Gabungkan kartu menu dengan data detail.
  const card = mapMenuCard(row, nowMs);
  return {
    ...card,
    description: row.description,
    gallery: parseGallery(row.gallery),
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

/**
 * Ulasan satu menu per halaman, terbaru dulu. Ulasan yang disembunyikan admin tidak ikut. Nama pembeli disamarkan:
 * hanya 2 huruf pertama lalu `***`.
 * @param rawId      id menu dari path URL, belum dicek
 * @param pagination nomor halaman dan jumlah baris per halaman
 * @returns `{ data, meta }`: ulasan (rating, komentar, nama samaran, tanggal) dan `{ page, limit, total }`
 * @throws 404 NOT_FOUND bila id tidak valid atau menu tidak tampil
 */
export async function listMenuReviews(rawId: unknown, pagination: Pagination) {
  const id = parseMenuId(rawId);
  // 1. Pastikan menunya tampil.
  const [existingMenus] = await db.query<RowDataPacket[]>(
    `SELECT x.id FROM ${MENU_FROM} WHERE x.id = ? AND ${MENU_VISIBLE}`,
    [id],
  );
  if (!existingMenus[0]) throw menuNotFound();
  // 2. Ambil satu halaman ulasan yang tidak disembunyikan.
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT r.rating, r.comment, u.full_name, r.created_at FROM reviews r JOIN users u ON u.id = r.customer_id
     WHERE r.menu_id = ? AND r.hidden_at IS NULL ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`,
    [id, pagination.limit, (pagination.page - 1) * pagination.limit],
  );
  // 3. Hitung total ulasan yang tampil untuk paginasi.
  const [countRows] = await db.query<RowDataPacket[]>(
    "SELECT COUNT(*) AS total FROM reviews WHERE menu_id = ? AND hidden_at IS NULL",
    [id],
  );
  // 4. Samarkan nama pembeli. Array.from memecah per karakter Unicode, jadi satu emoji tidak terbelah dua.
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

/**
 * Membuat galat "toko tidak ditemukan".
 * @returns AppError 404 NOT_FOUND yang siap dilempar
 */
export const merchantNotFound = () => new AppError(404, "NOT_FOUND", "Toko tidak ditemukan.");

/**
 * Membaca id toko dari path URL. Id yang bukan bilangan bulat positif (paling banyak 10 digit) diperlakukan sama dengan
 * toko yang tidak ada, seperti `menuId` untuk menu.
 * @param rawId id toko dari path URL, belum dicek
 * @returns id toko sebagai angka
 * @throws 404 NOT_FOUND bila id tidak valid
 */
export const parseMerchantId = (rawId: unknown): number => {
  const text = String(rawId);
  if (!/^[1-9]\d{0,9}$/.test(text)) throw merchantNotFound();
  return Number(text);
};

/** Bagian FROM SQL untuk kueri toko: toko beserta pemilik dan jenis usahanya. */
export const MERCHANT_FROM =
  "merchants m JOIN users u ON u.id = m.user_id JOIN merchant_types t ON t.id = m.merchant_type_id";

/**
 * Kolom SQL untuk {@link mapPublicMerchantProfile}, termasuk `fav` (toko ini favorit pembeli atau bukan). Dipakai
 * bersama {@link JOIN_FAVORITE_MERCHANT}, yang butuh 1 parameter: id pembeli atau null.
 */
export const MERCHANT_COLUMNS = `m.id, m.slug, m.business_name, m.description, m.logo_url, m.cover_url, m.is_open, m.open_time, m.close_time, m.rating_avg,
  m.rating_count, t.id AS t_id, t.name AS t_name, mf.user_id IS NOT NULL AS fav`;
/** Sambungan LEFT JOIN ke toko favorit milik satu pembeli; cara kerjanya sama dengan {@link JOIN_FAVORITE}. */
export const JOIN_FAVORITE_MERCHANT = "LEFT JOIN merchant_favorites mf ON mf.merchant_id = m.id AND mf.user_id = ?";

/**
 * Mengubah baris hasil {@link MERCHANT_COLUMNS} menjadi profil toko publik. Alamat, nomor WhatsApp, id pemilik, dan
 * status verifikasi sengaja tidak ikut; kunci ditulis satu per satu. Bentuk ini dipakai di halaman toko dan di daftar
 * toko favorit.
 * @param merchant     baris database dari kueri yang memakai {@link MERCHANT_COLUMNS}
 * @param nowMs        waktu sekarang dalam milidetik, untuk status buka toko
 * @param pickupPoints titik temu aktif toko ini
 * @returns profil toko publik
 */
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

/**
 * Profil toko publik berdasarkan slug, ditambah titik temu dan voucher toko yang sedang berlaku. Toko yang tutup
 * tetap tampil.
 * @param slug   nama toko di URL, contoh `dapur-bu-sri`
 * @param userId id pembeli yang login untuk tanda favorit dan tanda voucher sudah diklaim, atau null
 * @returns profil toko publik ditambah `vouchers`
 * @throws 404 NOT_FOUND bila slug tidak dikenal atau toko tidak lolos {@link MERCHANT_VISIBLE}
 */
export async function getMerchantProfile(slug: string, userId: number | null) {
  // 1. Ambil toko yang tampil.
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${MERCHANT_COLUMNS} FROM ${MERCHANT_FROM} ${JOIN_FAVORITE_MERCHANT} WHERE m.slug = ? AND ${MERCHANT_VISIBLE}`,
    [userId, slug],
  );
  const merchant = rows[0];
  if (!merchant) throw merchantNotFound();
  const nowMs = clock.now();
  // 2. Lengkapi dengan titik temu dan voucher publik toko. Tanda "sudah diklaim" hanya berarti untuk pembeli login.
  return {
    ...mapPublicMerchantProfile(merchant, nowMs, await getPickupPoints(merchant.id)),
    vouchers: await listMerchantVouchers(merchant.id, userId, nowMs),
  };
}
