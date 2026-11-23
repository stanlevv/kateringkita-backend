import { ResultSetHeader, RowDataPacket } from "mysql2";
import { z } from "zod";
import db from "../config/db";
import { Conn, dalamTransaksi } from "./admin-audit.service";
import { AppError } from "../utils/errors";
import { validateImageUrl } from "./upload.service";
import { getWibDate, refreshDailyQuota } from "./merchant-quota.service";
import { QuotaInput, MenuInput, MenuQuery, menuSchema } from "../dto/merchant-menu.dto";

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

// Kolom JSON: mysql2 mengurai JSON MySQL, tapi teks (mis. dari sisipan SQL) tetap diterima
export const parseGallery = (value: unknown): string[] => {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? parsed : [];
};

export const menuNotFound = () => new AppError(404, "NOT_FOUND", "Menu tidak ditemukan.");

// id path bukan bilangan bulat positif diperlakukan sama dengan menu orang lain (BE-01)
export const parseMenuId = (rawId: unknown): number => {
  const text = String(rawId);
  if (!/^[1-9]\d{0,9}$/.test(text)) throw menuNotFound();
  return Number(text);
};

export async function getMerchantId(userId: number): Promise<number> {
  const [rows] = await db.query<RowDataPacket[]>("SELECT id FROM merchants WHERE user_id = ?", [userId]);
  if (!rows[0]) throw new AppError(404, "NOT_FOUND", "Toko tidak ditemukan.");
  return rows[0].id;
}

const REMAINING_SQL = "(x.quota_today - x.sold_today - x.held_today)";
const STATUS_FILTERS: Record<NonNullable<MenuQuery["status"]>, string> = {
  active: "x.is_active",
  low: `x.is_active AND ${REMAINING_SQL} > 0 AND ${REMAINING_SQL} <= 3`,
  sold_out: `x.is_active AND ${REMAINING_SQL} <= 0`,
  inactive: "NOT x.is_active",
};

// Menu toko (belum terhapus) + opsi aktif: satu kueri menu, satu kueri opsi (tanpa N+1)
export async function loadMenus(
  merchantId: number,
  where: string[] = [],
  args: unknown[] = [],
): Promise<MerchantMenu[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT x.*, c.name AS c_name, c.slug AS c_slug FROM menus x JOIN categories c ON c.id = x.category_id
     WHERE x.merchant_id = ? AND x.deleted_at IS NULL${where.map((condition) => ` AND ${condition}`).join("")} ORDER BY x.id DESC`,
    [merchantId, ...args],
  );
  if (rows.length === 0) return [];
  const [menuOptions] = await db.query<RowDataPacket[]>(
    "SELECT id, menu_id, name, extra_price FROM menu_options WHERE menu_id IN (?) AND is_active ORDER BY id",
    [rows.map((row) => row.id)],
  );
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

export async function listMenus(userId: number, query: MenuQuery): Promise<MerchantMenu[]> {
  const merchantId = await getMerchantId(userId);
  await refreshDailyQuota(db, merchantId, getWibDate());
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
  return loadMenus(merchantId, where, args);
}

export async function getMenu(userId: number, rawId: unknown): Promise<MerchantMenu> {
  const id = parseMenuId(rawId);
  const merchantId = await getMerchantId(userId);
  await refreshDailyQuota(db, merchantId, getWibDate());
  const menu = await loadOneMenu(merchantId, id);
  if (!menu) throw menuNotFound();
  return menu;
}

const invalidField = (field: string, message: string) =>
  new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", { [field]: [message] });

// Kunci baris menu milik toko (urutan kunci: menus lalu menu_options); tidak ada/terhapus → 404
export async function lockMenu(conn: Conn, merchantId: number, id: number): Promise<RowDataPacket> {
  const [rows] = await conn.query<RowDataPacket[]>(
    "SELECT * FROM menus WHERE id = ? AND merchant_id = ? AND deleted_at IS NULL FOR UPDATE",
    [id, merchantId],
  );
  if (!rows[0]) throw menuNotFound();
  return rows[0];
}

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

// Validasi antar-field D9: yang tidak dikirim dibandingkan dengan nilai tersimpan; kategori & foto yang sama dengan tersimpan diterima
async function prepareMenuColumns(conn: Conn, merchantId: number, input: MenuInput, storedMenu: RowDataPacket | null) {
  const columnValues: Record<string, unknown> = {};
  for (const column of MENU_COLUMNS) if (input[column] !== undefined) columnValues[column] = input[column];
  if (columnValues.description === "") columnValues.description = null;
  if (input.price !== undefined || input.hpp !== undefined) {
    const costPrice: number = input.hpp ?? storedMenu!.hpp;
    if ((input.price ?? storedMenu!.price) <= costPrice)
      throw invalidField("price", `Harga jual harus lebih besar dari HPP (Rp ${costPrice.toLocaleString("id-ID")}).`);
  }
  if (input.is_preorder !== undefined || input.preorder_days !== undefined) {
    const isPreorder = input.is_preorder ?? Boolean(storedMenu!.is_preorder);
    const preorderDays: number = input.preorder_days ?? storedMenu!.preorder_days;
    if (isPreorder && !(preorderDays >= 1 && preorderDays <= 7))
      throw invalidField("preorder_days", "Hari pre-order harus 1 sampai 7.");
    columnValues.preorder_days = isPreorder ? preorderDays : 0;
  }
  if (input.category_id !== undefined && input.category_id !== storedMenu?.category_id) {
    const [categoryRows] = await conn.query<RowDataPacket[]>("SELECT id FROM categories WHERE id = ? AND is_active", [
      input.category_id,
    ]);
    if (!categoryRows[0]) throw invalidField("category_id", "Kategori tidak ditemukan.");
  }
  validateImageUrl(input.image_url, storedMenu?.image_url ?? null, `merchants/${merchantId}/menu/`, "image_url");
  if (input.gallery !== undefined) {
    // foto tersimpan boleh dipertahankan / diurutkan ulang; yang baru wajib unggahan menu toko ini
    const savedGallery = parseGallery(storedMenu?.gallery);
    for (const url of input.gallery)
      if (!savedGallery.includes(url)) validateImageUrl(url, null, `merchants/${merchantId}/menu/`, "gallery");
    columnValues.gallery = input.gallery.length ? JSON.stringify(input.gallery) : null;
  }
  return columnValues;
}

// D8: sinkron berdasarkan nama (tanpa beda huruf besar/kecil) agar option_ids di keranjang tidak rusak; yang hilang dinonaktifkan
async function syncOptions(
  conn: Conn,
  menuId: number,
  options: { name: string; extra_price: number }[],
): Promise<boolean> {
  const [existingOptions] = await conn.query<RowDataPacket[]>(
    "SELECT id, name, extra_price, is_active FROM menu_options WHERE menu_id = ? ORDER BY is_active, id FOR UPDATE",
    [menuId],
  );
  const optionsByName = new Map(existingOptions.map((option) => [String(option.name).toLowerCase(), option])); // baris aktif menang (urut is_active)
  const keptIds = new Set<number>();
  let changed = false;
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
  const removedIds = existingOptions
    .filter((option) => option.is_active && !keptIds.has(option.id))
    .map((option) => option.id);
  if (removedIds.length) await conn.query("UPDATE menu_options SET is_active = FALSE WHERE id IN (?)", [removedIds]);
  return changed || removedIds.length > 0;
}

const loadOneMenu = async (merchantId: number, id: number) => (await loadMenus(merchantId, ["x.id = ?"], [id]))[0];

export async function createMenu(userId: number, input: z.infer<typeof menuSchema>): Promise<MerchantMenu> {
  const merchantId = await getMerchantId(userId);
  const id = await dalamTransaksi(async (conn) => {
    const columnValues = await prepareMenuColumns(conn, merchantId, input, null);
    const [result] = await conn.query<ResultSetHeader>("INSERT INTO menus SET ?", [
      { ...columnValues, merchant_id: merchantId, quota_today: input.daily_quota, stock_date: getWibDate() },
    ]);
    if (input.options.length) {
      await conn.query("INSERT INTO menu_options (menu_id, name, extra_price) VALUES ?", [
        input.options.map((option) => [result.insertId, option.name, option.extra_price]),
      ]);
    }
    return result.insertId;
  });
  return loadOneMenu(merchantId, id);
}

// daily_quota hanya berlaku mulai hari berikutnya (D6); kolom sistem tidak pernah dari klien
export async function updateMenu(userId: number, rawId: unknown, input: MenuInput): Promise<MerchantMenu> {
  const id = parseMenuId(rawId);
  const merchantId = await getMerchantId(userId);
  if (Object.keys(input).length === 0) throw new AppError(400, "VALIDATION_ERROR", "Tidak ada data yang diubah.");
  await dalamTransaksi(async (conn) => {
    await refreshDailyQuota(conn, merchantId, getWibDate());
    const storedMenu = await lockMenu(conn, merchantId, id);
    // F19: menu yang diturunkan admin tidak bisa diaktifkan penjual
    if (input.is_active === true && storedMenu.moderated_at) {
      throw new AppError(
        409,
        "CONFLICT",
        `Menu ini diturunkan admin: ${storedMenu.moderation_reason}. Hubungi admin untuk memulihkan.`,
      );
    }
    const columnValues = await prepareMenuColumns(conn, merchantId, input, storedMenu);
    const optionsChanged = input.options ? await syncOptions(conn, id, input.options) : false;
    const columns = Object.keys(columnValues);
    // kolom yang berubah menggeser updated_at otomatis; perubahan opsi saja digeser eksplisit (D7)
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
  return loadOneMenu(merchantId, id);
}

// Soft delete (BE-11): baris tetap untuk order_items (FK RESTRICT) dan laporan; hilang dari semua rute penjual
export async function deleteMenu(userId: number, rawId: unknown): Promise<void> {
  const id = parseMenuId(rawId);
  const merchantId = await getMerchantId(userId);
  await dalamTransaksi(async (conn) => {
    const [result] = await conn.query<ResultSetHeader>(
      "UPDATE menus SET deleted_at = UTC_TIMESTAMP(), is_active = FALSE WHERE id = ? AND merchant_id = ? AND deleted_at IS NULL",
      [id, merchantId],
    );
    if (result.affectedRows === 0) throw menuNotFound();
  });
}

// D5: satu transaksi, baris menu dikunci (sama dengan checkout F06) → tanpa lost update, tidak pernah < terjual + ditahan.
// updated_at tidak digeser (D7). Aturan di aplikasi karena TiDB tidak menegakkan CHECK.
export async function updateQuota(userId: number, rawId: unknown, input: QuotaInput): Promise<MerchantMenu> {
  const id = parseMenuId(rawId);
  const merchantId = await getMerchantId(userId);
  await dalamTransaksi(async (conn) => {
    await refreshDailyQuota(conn, merchantId, getWibDate());
    const menu = await lockMenu(conn, merchantId, id);
    const newQuota: number = input.delta !== undefined ? menu.quota_today + input.delta : input.quota_today!;
    if (newQuota > 10_000) throw invalidField("quota_today", "Kuota hari ini maksimal 10.000.");
    if (newQuota < 0) throw new AppError(409, "CONFLICT", "Kuota tidak bisa kurang dari 0.");
    const orderedPortions: number = menu.sold_today + menu.held_today;
    if (newQuota < orderedPortions)
      throw new AppError(409, "CONFLICT", `Kuota tidak bisa di bawah porsi yang sudah dipesan (${orderedPortions}).`);
    await conn.query("UPDATE menus SET quota_today = ?, updated_at = updated_at WHERE id = ?", [newQuota, id]);
  });
  return loadOneMenu(merchantId, id);
}
