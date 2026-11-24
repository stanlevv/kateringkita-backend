// Isi file: menu milik penjual yang login: daftar, detail, tambah, ubah (termasuk opsi tambahan dan foto), hapus, dan
// ubah kuota hari ini. Alurnya routes/merchant.ts → handlers/merchant.handler.ts → file ini → database. Toko selalu
// dicari dari id pengguna di token login dan setiap kueri menu disaring `merchant_id` toko itu, jadi penjual hanya
// bisa membaca dan mengubah menunya sendiri. Beberapa fungsi kecil di sini (id toko, id menu, galeri) juga dipakai
// service lain.
import { ResultSetHeader, RowDataPacket } from "mysql2";
import { z } from "zod";
import db from "../config/db";
import { Conn, withTransaction } from "./admin-audit.service";
import { AppError } from "../utils/errors";
import { validateImageUrl } from "./upload.service";
import { getWibDate, refreshDailyQuota } from "./merchant-quota.service";
import { QuotaInput, MenuInput, MenuQuery, menuSchema } from "../dto/merchant-menu.dto";

/**
 * Bentuk satu menu di respons penjual. Nama kuncinya ikut terkirim apa adanya sebagai JSON. `hpp` = harga pokok
 * penjualan (modal per porsi), `margin` = harga jual − HPP. Angka stok berlaku untuk hari ini: `quota_today` (kuota),
 * `sold_today` (terjual), `held_today` (ditahan pesanan yang menunggu bayar/konfirmasi), dan `available` (sisa =
 * kuota − terjual − ditahan). `daily_quota` = kuota harian yang dipakai saat reset hari berikutnya.
 */
export type MerchantMenu = {
  id: number;
  name: string;
  description: string | null;
  image_url: string | null;
  gallery: string[];
  category: { id: number; name: string; slug: string };
  unit_label: string;
  price: number;
  hpp: number;
  margin: number;
  daily_quota: number;
  quota_today: number;
  sold_today: number;
  held_today: number;
  available: number;
  prep_minutes: number;
  is_preorder: boolean;
  preorder_days: number;
  min_order_qty: number;
  is_active: boolean;
  options: { id: number; name: string; extra_price: number }[];
  rating_avg: number;
  rating_count: number;
};

/**
 * Membaca kolom `gallery` (daftar URL foto tambahan) dari database. Biasanya mysql2 sudah mengubah kolom JSON menjadi
 * array, tetapi isi berupa teks JSON (misalnya dari data yang disisipkan lewat SQL) tetap diterima.
 * @param value isi kolom `gallery`: array, teks JSON, atau null
 * @returns daftar URL foto; array kosong bila kolom kosong atau bukan array
 * @throws SyntaxError bila isinya teks yang bukan JSON
 */
export const parseGallery = (value: unknown): string[] => {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? parsed : [];
};

/**
 * Membuat galat 404 "Menu tidak ditemukan.".
 * @returns galat yang siap dilempar
 */
export const menuNotFound = () => new AppError(404, "NOT_FOUND", "Menu tidak ditemukan.");

/**
 * Mengubah id menu dari path URL menjadi angka. Id yang bukan bilangan bulat positif (paling banyak 10 digit) dijawab
 * 404, sama dengan menu milik toko lain, supaya pengirim tidak bisa membedakan keduanya.
 * @param rawId id dari path, contoh `"12"`
 * @returns id menu berupa angka
 * @throws 404 bila id tidak berbentuk bilangan bulat positif
 */
export const parseMenuId = (rawId: unknown): number => {
  const text = String(rawId);
  if (!/^[1-9]\d{0,9}$/.test(text)) throw menuNotFound();
  return Number(text);
};

/**
 * Mencari id toko milik pengguna yang login. Dipakai semua fitur penjual (menu, pesanan, laporan, promo, banner, meja,
 * ulasan, asisten) supaya toko selalu berasal dari token, bukan dari isi request.
 * @param userId id pengguna penjual dari token login
 * @returns id toko
 * @throws 404 bila pengguna ini tidak punya toko
 */
export async function getMerchantId(userId: number): Promise<number> {
  const [rows] = await db.query<RowDataPacket[]>("SELECT id FROM merchants WHERE user_id = ?", [userId]);
  if (!rows[0]) throw new AppError(404, "NOT_FOUND", "Toko tidak ditemukan.");
  return rows[0].id;
}

// Rumus SQL sisa porsi hari ini (`x` = alias tabel menus di kueri). Dipakai sesudah reset kuota harian, jadi angka
// kuota sudah milik hari ini.
const REMAINING_SQL = "(x.quota_today - x.sold_today - x.held_today)";
// Syarat SQL untuk filter `status`: aktif, stok sedikit (menu aktif dengan sisa 1–3), habis (menu aktif dengan sisa
// 0 atau kurang), dan nonaktif.
const STATUS_FILTERS: Record<NonNullable<MenuQuery["status"]>, string> = {
  active: "x.is_active",
  low: `x.is_active AND ${REMAINING_SQL} > 0 AND ${REMAINING_SQL} <= 3`,
  sold_out: `x.is_active AND ${REMAINING_SQL} <= 0`,
  inactive: "NOT x.is_active",
};

/**
 * Membaca menu satu toko (yang belum dihapus) beserta opsi tambahannya yang aktif, urut dari menu terbaru. Hanya dua
 * kueri: satu untuk semua menu dan satu untuk semua opsinya, bukan satu kueri opsi per menu.
 * @param merchantId id toko
 * @param where      syarat SQL tambahan yang ditulis tetap di kode (bukan dari pengguna); nilainya memakai `?`
 * @param args       nilai untuk setiap `?` di `where`, berurutan
 * @returns daftar menu berbentuk {@link MerchantMenu}; kosong bila tidak ada yang cocok
 */
export async function loadMenus(
  merchantId: number,
  where: string[] = [],
  args: unknown[] = [],
): Promise<MerchantMenu[]> {
  // 1. Ambil menu beserta nama dan slug kategorinya (`x` = menus, `c` = categories).
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT x.*, c.name AS c_name, c.slug AS c_slug FROM menus x JOIN categories c ON c.id = x.category_id
     WHERE x.merchant_id = ? AND x.deleted_at IS NULL${where.map((condition) => ` AND ${condition}`).join("")} ORDER BY x.id DESC`,
    [merchantId, ...args],
  );
  if (rows.length === 0) return [];
  // 2. Ambil semua opsi aktif milik menu-menu itu sekaligus.
  const [menuOptions] = await db.query<RowDataPacket[]>(
    "SELECT id, menu_id, name, extra_price FROM menu_options WHERE menu_id IN (?) AND is_active ORDER BY id",
    [rows.map((row) => row.id)],
  );
  // 3. Susun respons; opsi dibagikan ke menunya masing-masing.
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    image_url: row.image_url,
    gallery: parseGallery(row.gallery),
    category: { id: row.category_id, name: row.c_name, slug: row.c_slug },
    unit_label: row.unit_label,
    price: row.price,
    hpp: row.hpp,
    margin: row.price - row.hpp,
    daily_quota: row.daily_quota,
    quota_today: row.quota_today,
    sold_today: row.sold_today,
    held_today: row.held_today,
    available: row.quota_today - row.sold_today - row.held_today,
    prep_minutes: row.prep_minutes,
    is_preorder: Boolean(row.is_preorder),
    preorder_days: row.preorder_days,
    min_order_qty: row.min_order_qty,
    is_active: Boolean(row.is_active),
    options: menuOptions
      .filter((option) => option.menu_id === row.id)
      .map((option) => ({ id: option.id, name: option.name, extra_price: option.extra_price })),
    rating_avg: Number(row.rating_avg),
    rating_count: row.rating_count,
  }));
}

/**
 * Daftar menu toko untuk halaman kelola menu penjual, dengan pencarian dan filter.
 * @param userId id pengguna penjual dari token login
 * @param query  filter yang sudah lolos menuQuerySchema: `q` (kata cari di nama menu), `category` (slug kategori),
 *               dan `status` (active, low, sold_out, inactive)
 * @returns daftar menu toko, terbaru di atas
 * @throws 404 bila pengguna ini tidak punya toko
 */
export async function listMenus(userId: number, query: MenuQuery): Promise<MerchantMenu[]> {
  // 1. Cari toko, lalu reset kuota harian bila sudah ganti hari supaya angka stok yang tampil milik hari ini.
  const merchantId = await getMerchantId(userId);
  await refreshDailyQuota(db, merchantId, getWibDate());
  // 2. Susun syarat filter. Kata cari tidak peka huruf besar/kecil; tanda `\`, `%`, dan `_` diberi garis miring
  //    terbalik supaya dibaca sebagai huruf biasa, bukan pola LIKE.
  const where: string[] = [];
  const args: unknown[] = [];
  if (query.q) {
    where.push("LOWER(x.name) LIKE LOWER(?)");
    args.push(`%${query.q.replace(/[\\%_]/g, "\\$&")}%`);
  }
  if (query.category) {
    where.push("c.slug = ?");
    args.push(query.category);
  }
  if (query.status) where.push(STATUS_FILTERS[query.status]);
  // 3. Baca menu dengan syarat itu.
  return loadMenus(merchantId, where, args);
}

/**
 * Detail satu menu milik toko penjual yang login, dengan angka stok hari ini.
 * @param userId id pengguna penjual dari token login
 * @param rawId  id menu dari path URL
 * @returns menu berbentuk {@link MerchantMenu}
 * @throws 404 bila id tidak sah, menu tidak ada, sudah dihapus, milik toko lain, atau pengguna tidak punya toko
 */
export async function getMenu(userId: number, rawId: unknown): Promise<MerchantMenu> {
  const id = parseMenuId(rawId);
  const merchantId = await getMerchantId(userId);
  await refreshDailyQuota(db, merchantId, getWibDate());
  const menu = await loadOneMenu(merchantId, id);
  if (!menu) throw menuNotFound();
  return menu;
}

// Galat 400 untuk satu kolom, contoh `{ price: ["Harga jual harus lebih besar dari HPP (Rp 5.000)."] }`.
const invalidField = (field: string, message: string) =>
  new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", { [field]: [message] });

/**
 * Membaca satu baris menu milik toko sambil menguncinya (`FOR UPDATE`): transaksi lain yang ingin mengubah menu ini
 * harus menunggu sampai transaksi pemanggil selesai. Urutan kunci selalu menus dulu, baru menu_options.
 * @param conn       koneksi di dalam transaksi pemanggil
 * @param merchantId id toko pemilik
 * @param id         id menu
 * @returns baris menu lengkap dari database
 * @throws 404 bila menu tidak ada, sudah dihapus, atau milik toko lain
 */
export async function lockMenu(conn: Conn, merchantId: number, id: number): Promise<RowDataPacket> {
  const [rows] = await conn.query<RowDataPacket[]>(
    "SELECT * FROM menus WHERE id = ? AND merchant_id = ? AND deleted_at IS NULL FOR UPDATE",
    [id, merchantId],
  );
  if (!rows[0]) throw menuNotFound();
  return rows[0];
}

// Kolom menu yang boleh diisi penjual dan disalin dari body. Kolom stok hari ini (`quota_today`, `sold_today`,
// `held_today`, `stock_date`) dan `merchant_id` tidak ada di sini, jadi tidak pernah diisi dari request.
const MENU_COLUMNS = [
  "name",
  "category_id",
  "description",
  "image_url",
  "unit_label",
  "price",
  "hpp",
  "daily_quota",
  "prep_minutes",
  "is_preorder",
  "preorder_days",
  "min_order_qty",
  "is_active",
] as const;

// Memeriksa aturan yang melibatkan lebih dari satu kolom lalu menyiapkan nilai kolom untuk INSERT/UPDATE. Kolom yang
// tidak dikirim dibandingkan dengan nilai tersimpan (`storedMenu`, null saat menu baru). Kategori dan foto yang sama
// dengan yang tersimpan diterima tanpa dicek ulang. Galat 400 dilempar per kolom.
async function prepareMenuColumns(conn: Conn, merchantId: number, input: MenuInput, storedMenu: RowDataPacket | null) {
  // 1. Salin kolom yang dikirim; deskripsi kosong disimpan sebagai null.
  const columnValues: Record<string, unknown> = {};
  for (const column of MENU_COLUMNS) if (input[column] !== undefined) columnValues[column] = input[column];
  if (columnValues.description === "") columnValues.description = null;
  // 2. Harga jual harus lebih besar dari HPP (harga pokok/modal per porsi).
  if (input.price !== undefined || input.hpp !== undefined) {
    const costPrice: number = input.hpp ?? storedMenu!.hpp;
    if ((input.price ?? storedMenu!.price) <= costPrice)
      throw invalidField("price", `Harga jual harus lebih besar dari HPP (Rp ${costPrice.toLocaleString("id-ID")}).`);
  }
  // 3. Menu pre-order (dipesan beberapa hari sebelumnya) wajib 1–7 hari; menu biasa selalu disimpan 0 hari.
  if (input.is_preorder !== undefined || input.preorder_days !== undefined) {
    const isPreorder = input.is_preorder ?? Boolean(storedMenu!.is_preorder);
    const preorderDays: number = input.preorder_days ?? storedMenu!.preorder_days;
    if (isPreorder && !(preorderDays >= 1 && preorderDays <= 7))
      throw invalidField("preorder_days", "Hari pre-order harus 1 sampai 7.");
    columnValues.preorder_days = isPreorder ? preorderDays : 0;
  }
  // 4. Kategori yang berbeda dari yang tersimpan harus ada dan aktif.
  if (input.category_id !== undefined && input.category_id !== storedMenu?.category_id) {
    const [categoryRows] = await conn.query<RowDataPacket[]>("SELECT id FROM categories WHERE id = ? AND is_active", [
      input.category_id,
    ]);
    if (!categoryRows[0]) throw invalidField("category_id", "Kategori tidak ditemukan.");
  }
  // 5. Foto utama baru harus hasil unggahan ke folder menu toko ini.
  validateImageUrl(input.image_url, storedMenu?.image_url ?? null, `merchants/${merchantId}/menu/`, "image_url");
  if (input.gallery !== undefined) {
    // 6. Foto tambahan yang sudah tersimpan boleh dipertahankan atau diurutkan ulang; yang baru wajib unggahan menu
    //    toko ini. Daftar kosong disimpan sebagai null.
    const savedGallery = parseGallery(storedMenu?.gallery);
    for (const url of input.gallery)
      if (!savedGallery.includes(url)) validateImageUrl(url, null, `merchants/${merchantId}/menu/`, "gallery");
    columnValues.gallery = input.gallery.length ? JSON.stringify(input.gallery) : null;
  }
  return columnValues;
}

// Menyamakan opsi tambahan menu (contoh "Ekstra sambal") dengan daftar dari penjual. Opsi dicocokkan menurut nama
// tanpa membedakan huruf besar/kecil, sehingga opsi lama tetap memakai id yang sama dan `option_ids` di keranjang
// pembeli tidak rusak. Opsi yang tidak ada lagi di daftar dinonaktifkan, tidak dihapus. Mengembalikan true bila ada
// yang berubah.
async function syncOptions(
  conn: Conn,
  menuId: number,
  options: { name: string; extra_price: number }[],
): Promise<boolean> {
  // 1. Baca semua opsi menu (aktif dan nonaktif) sambil dikunci.
  const [existingOptions] = await conn.query<RowDataPacket[]>(
    "SELECT id, name, extra_price, is_active FROM menu_options WHERE menu_id = ? ORDER BY is_active, id FOR UPDATE",
    [menuId],
  );
  // 2. Peta nama (huruf kecil) → opsi. Baris nonaktif dibaca lebih dulu, jadi bila ada nama kembar, baris aktif yang
  //    masuk terakhir dan menang.
  const optionsByName = new Map(existingOptions.map((option) => [String(option.name).toLowerCase(), option]));
  const keptIds = new Set<number>();
  let changed = false;
  // 3. Nama baru disisipkan; opsi lama yang berubah nama/harga atau sedang nonaktif diperbarui dan diaktifkan lagi.
  for (const option of options) {
    const existing = optionsByName.get(option.name.toLowerCase());
    if (!existing) {
      await conn.query("INSERT INTO menu_options (menu_id, name, extra_price) VALUES (?, ?, ?)", [
        menuId,
        option.name,
        option.extra_price,
      ]);
      changed = true;
      continue;
    }
    keptIds.add(existing.id);
    if (existing.name !== option.name || existing.extra_price !== option.extra_price || !existing.is_active) {
      await conn.query("UPDATE menu_options SET name = ?, extra_price = ?, is_active = TRUE WHERE id = ?", [
        option.name,
        option.extra_price,
        existing.id,
      ]);
      changed = true;
    }
  }
  // 4. Opsi aktif yang tidak ada di daftar dinonaktifkan.
  const removedIds = existingOptions
    .filter((option) => option.is_active && !keptIds.has(option.id))
    .map((option) => option.id);
  if (removedIds.length) await conn.query("UPDATE menu_options SET is_active = FALSE WHERE id IN (?)", [removedIds]);
  return changed || removedIds.length > 0;
}

// Membaca satu menu toko lewat loadMenus; hasilnya undefined bila tidak ada.
const loadOneMenu = async (merchantId: number, id: number) => (await loadMenus(merchantId, ["x.id = ?"], [id]))[0];

/**
 * Menambah menu baru ke toko penjual yang login, beserta opsi tambahannya. Kuota hari ini langsung diisi sama dengan
 * kuota harian dan tanggal stoknya hari ini (WIB). Semua langkah berjalan dalam satu transaksi DB: rangkaian
 * perubahan yang disimpan semua atau dibatalkan semua.
 * @param userId id pengguna penjual dari token login
 * @param input  body yang sudah lolos menuSchema
 * @returns menu yang baru dibuat
 * @throws 400 bila harga jual tidak di atas HPP, hari pre-order salah, kategori tidak ada, atau foto bukan unggahan
 *         toko ini; 404 bila pengguna tidak punya toko
 */
export async function createMenu(userId: number, input: z.infer<typeof menuSchema>): Promise<MerchantMenu> {
  const merchantId = await getMerchantId(userId);
  const id = await withTransaction(async (conn) => {
    // 1. Periksa dan siapkan kolom, lalu sisipkan baris menu.
    const columnValues = await prepareMenuColumns(conn, merchantId, input, null);
    const [result] = await conn.query<ResultSetHeader>("INSERT INTO menus SET ?", [
      { ...columnValues, merchant_id: merchantId, quota_today: input.daily_quota, stock_date: getWibDate() },
    ]);
    // 2. Sisipkan semua opsi tambahan sekaligus.
    if (input.options.length) {
      await conn.query("INSERT INTO menu_options (menu_id, name, extra_price) VALUES ?", [
        input.options.map((option) => [result.insertId, option.name, option.extra_price]),
      ]);
    }
    return result.insertId;
  });
  // 3. Kirim menu yang baru dibuat dalam bentuk respons lengkap.
  return loadOneMenu(merchantId, id);
}

/**
 * Mengubah sebagian data menu milik toko penjual yang login. Hanya kolom yang dikirim yang diubah. Perubahan kuota
 * harian (`daily_quota`) baru berlaku mulai hari berikutnya; untuk hari ini penjual memakai {@link updateQuota}.
 * Semua langkah berjalan dalam satu transaksi DB.
 * @param userId id pengguna penjual dari token login
 * @param rawId  id menu dari path URL
 * @param input  body yang sudah lolos menuPatchSchema (semua kolom opsional)
 * @returns menu setelah diubah
 * @throws 400 bila tidak ada data yang diubah atau aturan kolom dilanggar (lihat createMenu); 404 bila menu tidak
 *         ditemukan; 409 bila penjual mencoba mengaktifkan menu yang sedang diturunkan admin
 */
export async function updateMenu(userId: number, rawId: unknown, input: MenuInput): Promise<MerchantMenu> {
  const id = parseMenuId(rawId);
  const merchantId = await getMerchantId(userId);
  if (Object.keys(input).length === 0) throw new AppError(400, "VALIDATION_ERROR", "Tidak ada data yang diubah.");
  await withTransaction(async (conn) => {
    // 1. Reset kuota harian bila sudah ganti hari, lalu kunci baris menu.
    await refreshDailyQuota(conn, merchantId, getWibDate());
    const storedMenu = await lockMenu(conn, merchantId, id);
    // 2. Menu yang diturunkan admin (moderasi) tidak bisa diaktifkan lagi oleh penjual.
    if (input.is_active === true && storedMenu.moderated_at) {
      throw new AppError(
        409,
        "CONFLICT",
        `Menu ini diturunkan admin: ${storedMenu.moderation_reason}. Hubungi admin untuk memulihkan.`,
      );
    }
    // 3. Periksa kolom, lalu samakan opsi tambahan bila dikirim.
    const columnValues = await prepareMenuColumns(conn, merchantId, input, storedMenu);
    const optionsChanged = input.options ? await syncOptions(conn, id, input.options) : false;
    const columns = Object.keys(columnValues);
    // 4. Simpan kolom. `updated_at` bergeser sendiri bila ada kolom yang berubah; bila hanya opsi yang berubah,
    //    `updated_at` digeser dengan tangan.
    const assignments = [
      ...columns.map((column) => `${column} = ?`),
      ...(optionsChanged ? ["updated_at = CURRENT_TIMESTAMP"] : []),
    ];
    if (assignments.length)
      await conn.query(`UPDATE menus SET ${assignments.join(", ")} WHERE id = ?`, [
        ...columns.map((column) => columnValues[column]),
        id,
      ]);
  });
  // 5. Kirim menu terbaru.
  return loadOneMenu(merchantId, id);
}

/**
 * Menghapus menu milik toko penjual yang login dengan soft delete: baris tidak dihapus dari database, hanya diberi
 * waktu hapus (`deleted_at`) dan dinonaktifkan. Baris harus tetap ada karena dirujuk item pesanan lama (database
 * menolak menghapus menu yang masih dirujuk order_items) dan dipakai laporan. Menu yang sudah dihapus tidak muncul
 * lagi di semua rute penjual.
 * @param userId id pengguna penjual dari token login
 * @param rawId  id menu dari path URL
 * @returns tidak ada
 * @throws 404 bila menu tidak ada, sudah dihapus, atau milik toko lain
 */
export async function deleteMenu(userId: number, rawId: unknown): Promise<void> {
  const id = parseMenuId(rawId);
  const merchantId = await getMerchantId(userId);
  await withTransaction(async (conn) => {
    const [result] = await conn.query<ResultSetHeader>(
      "UPDATE menus SET deleted_at = UTC_TIMESTAMP(), is_active = FALSE WHERE id = ? AND merchant_id = ? AND deleted_at IS NULL",
      [id, merchantId],
    );
    if (result.affectedRows === 0) throw menuNotFound();
  });
}

/**
 * Mengubah kuota hari ini satu menu, baik ditambah/dikurangi (`delta`) maupun diganti langsung (`quota_today`).
 * Berjalan dalam satu transaksi dengan baris menu dikunci, sama seperti checkout, jadi dua perubahan bersamaan tidak
 * saling menimpa. Aturan batas dicek di kode karena TiDB (database production) tidak menegakkan CHECK di tabel.
 * Waktu terakhir diubah (`updated_at`) sengaja tidak digeser.
 * @param userId id pengguna penjual dari token login
 * @param rawId  id menu dari path URL
 * @param input  body yang sudah lolos quotaSchema: tepat salah satu dari `delta` atau `quota_today`
 * @returns menu dengan kuota terbaru
 * @throws 400 bila kuota baru lebih dari 10.000; 404 bila menu tidak ditemukan; 409 bila kuota baru kurang dari 0
 *         atau kurang dari porsi yang sudah terjual ditambah yang sedang ditahan
 */
export async function updateQuota(userId: number, rawId: unknown, input: QuotaInput): Promise<MerchantMenu> {
  const id = parseMenuId(rawId);
  const merchantId = await getMerchantId(userId);
  await withTransaction(async (conn) => {
    // 1. Reset kuota harian bila sudah ganti hari, lalu kunci baris menu.
    await refreshDailyQuota(conn, merchantId, getWibDate());
    const menu = await lockMenu(conn, merchantId, id);
    // 2. Hitung kuota baru dari `delta` atau `quota_today`, lalu cek batasnya.
    const newQuota: number = input.delta !== undefined ? menu.quota_today + input.delta : input.quota_today!;
    if (newQuota > 10_000) throw invalidField("quota_today", "Kuota hari ini maksimal 10.000.");
    if (newQuota < 0) throw new AppError(409, "CONFLICT", "Kuota tidak bisa kurang dari 0.");
    const orderedPortions: number = menu.sold_today + menu.held_today;
    if (newQuota < orderedPortions)
      throw new AppError(409, "CONFLICT", `Kuota tidak bisa di bawah porsi yang sudah dipesan (${orderedPortions}).`);
    // 3. Simpan kuota baru.
    await conn.query("UPDATE menus SET quota_today = ?, updated_at = updated_at WHERE id = ?", [newQuota, id]);
  });
  // 4. Kirim menu dengan kuota terbaru.
  return loadOneMenu(merchantId, id);
}
