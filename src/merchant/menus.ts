import { ResultSetHeader, RowDataPacket } from "mysql2";
import { z } from "zod";
import db from "../config/db";
import { Conn, dalamTransaksi } from "../admin/audit";
import { AppError } from "../http/errors";
import { cekUrlGambar } from "../upload/service";
import { hariIniWib, segarkanKuota } from "./kuota";
import { KuotaInput, MenuInput, MenuQuery, menuSchema } from "./menuSchemas";

export type MerchantMenu = {
  id: number; name: string; description: string | null; image_url: string | null;
  category: { id: number; name: string; slug: string }; unit_label: string;
  price: number; hpp: number; margin: number; daily_quota: number; quota_today: number; sold_today: number; held_today: number;
  available: number; prep_minutes: number; is_preorder: boolean; preorder_days: number; min_order_qty: number; is_active: boolean;
  options: { id: number; name: string; extra_price: number }[]; rating_avg: number; rating_count: number;
};

export const menuTidakAda = () => new AppError(404, "NOT_FOUND", "Menu tidak ditemukan.");

// id path bukan bilangan bulat positif diperlakukan sama dengan menu orang lain (BE-01)
export const menuId = (idRaw: unknown): number => {
  const s = String(idRaw);
  if (!/^[1-9]\d{0,9}$/.test(s)) throw menuTidakAda();
  return Number(s);
};

export async function idToko(userId: number): Promise<number> {
  const [r] = await db.query<RowDataPacket[]>("SELECT id FROM merchants WHERE user_id = ?", [userId]);
  if (!r[0]) throw new AppError(404, "NOT_FOUND", "Toko tidak ditemukan.");
  return r[0].id;
}

const SISA = "(x.quota_today - x.sold_today - x.held_today)";
const STATUS: Record<NonNullable<MenuQuery["status"]>, string> = {
  active: "x.is_active",
  low: `x.is_active AND ${SISA} > 0 AND ${SISA} <= 3`,
  sold_out: `x.is_active AND ${SISA} <= 0`,
  inactive: "NOT x.is_active",
};

// Menu toko (belum terhapus) + opsi aktif: satu kueri menu, satu kueri opsi (tanpa N+1)
export async function bacaMenu(merchantId: number, where: string[] = [], args: unknown[] = []): Promise<MerchantMenu[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT x.*, c.name AS c_name, c.slug AS c_slug FROM menus x JOIN categories c ON c.id = x.category_id
     WHERE x.merchant_id = ? AND x.deleted_at IS NULL${where.map((w) => ` AND ${w}`).join("")} ORDER BY x.id DESC`,
    [merchantId, ...args],
  );
  if (rows.length === 0) return [];
  const [ops] = await db.query<RowDataPacket[]>(
    "SELECT id, menu_id, name, extra_price FROM menu_options WHERE menu_id IN (?) AND is_active ORDER BY id",
    [rows.map((r) => r.id)],
  );
  return rows.map((r) => ({
    id: r.id, name: r.name, description: r.description, image_url: r.image_url,
    category: { id: r.category_id, name: r.c_name, slug: r.c_slug }, unit_label: r.unit_label,
    price: r.price, hpp: r.hpp, margin: r.price - r.hpp, daily_quota: r.daily_quota,
    quota_today: r.quota_today, sold_today: r.sold_today, held_today: r.held_today,
    available: r.quota_today - r.sold_today - r.held_today,
    prep_minutes: r.prep_minutes, is_preorder: Boolean(r.is_preorder), preorder_days: r.preorder_days, min_order_qty: r.min_order_qty,
    is_active: Boolean(r.is_active),
    options: ops.filter((o) => o.menu_id === r.id).map((o) => ({ id: o.id, name: o.name, extra_price: o.extra_price })),
    rating_avg: Number(r.rating_avg), rating_count: r.rating_count,
  }));
}

export async function daftarMenu(userId: number, q: MenuQuery): Promise<MerchantMenu[]> {
  const mid = await idToko(userId);
  await segarkanKuota(db, mid, hariIniWib());
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.q) {
    where.push("LOWER(x.name) LIKE LOWER(?)");
    args.push(`%${q.q.replace(/[\\%_]/g, "\\$&")}%`);
  }
  if (q.category) {
    where.push("c.slug = ?");
    args.push(q.category);
  }
  if (q.status) where.push(STATUS[q.status]);
  return bacaMenu(mid, where, args);
}

export async function ambilMenu(userId: number, idRaw: unknown): Promise<MerchantMenu> {
  const id = menuId(idRaw);
  const mid = await idToko(userId);
  await segarkanKuota(db, mid, hariIniWib());
  const m = await satu(mid, id);
  if (!m) throw menuTidakAda();
  return m;
}

const invalidField = (field: string, pesan: string) => new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", { [field]: [pesan] });

// Kunci baris menu milik toko (urutan kunci: menus lalu menu_options); tidak ada/terhapus → 404
export async function kunciMenu(conn: Conn, merchantId: number, id: number): Promise<RowDataPacket> {
  const [r] = await conn.query<RowDataPacket[]>(
    "SELECT * FROM menus WHERE id = ? AND merchant_id = ? AND deleted_at IS NULL FOR UPDATE", [id, merchantId],
  );
  if (!r[0]) throw menuTidakAda();
  return r[0];
}

const KOLOM = [
  "name", "category_id", "description", "image_url", "unit_label", "price", "hpp", "daily_quota", "prep_minutes", "is_preorder",
  "preorder_days", "min_order_qty", "is_active",
] as const;

// Validasi antar-field D9: yang tidak dikirim dibandingkan dengan nilai tersimpan; kategori & foto yang sama dengan tersimpan diterima
async function kolomMenu(conn: Conn, merchantId: number, input: MenuInput, lama: RowDataPacket | null) {
  const sets: Record<string, unknown> = {};
  for (const k of KOLOM) if (input[k] !== undefined) sets[k] = input[k];
  if (sets.description === "") sets.description = null;
  if (input.price !== undefined || input.hpp !== undefined) {
    const hpp: number = input.hpp ?? lama!.hpp;
    if ((input.price ?? lama!.price) <= hpp) throw invalidField("price", `Harga jual harus lebih besar dari HPP (Rp ${hpp.toLocaleString("id-ID")}).`);
  }
  if (input.is_preorder !== undefined || input.preorder_days !== undefined) {
    const pre = input.is_preorder ?? Boolean(lama!.is_preorder);
    const hari: number = input.preorder_days ?? lama!.preorder_days;
    if (pre && !(hari >= 1 && hari <= 7)) throw invalidField("preorder_days", "Hari pre-order harus 1 sampai 7.");
    sets.preorder_days = pre ? hari : 0;
  }
  if (input.category_id !== undefined && input.category_id !== lama?.category_id) {
    const [c] = await conn.query<RowDataPacket[]>("SELECT id FROM categories WHERE id = ? AND is_active", [input.category_id]);
    if (!c[0]) throw invalidField("category_id", "Kategori tidak ditemukan.");
  }
  cekUrlGambar(input.image_url, lama?.image_url ?? null, `merchants/${merchantId}/menu/`, "image_url");
  return sets;
}

// D8: sinkron berdasarkan nama (tanpa beda huruf besar/kecil) agar option_ids di keranjang tidak rusak; yang hilang dinonaktifkan
async function sinkronOpsi(conn: Conn, menuId: number, list: { name: string; extra_price: number }[]): Promise<boolean> {
  const [lama] = await conn.query<RowDataPacket[]>(
    "SELECT id, name, extra_price, is_active FROM menu_options WHERE menu_id = ? ORDER BY is_active, id FOR UPDATE", [menuId],
  );
  const peta = new Map(lama.map((o) => [String(o.name).toLowerCase(), o])); // baris aktif menang (urut is_active)
  const dipakai = new Set<number>();
  let berubah = false;
  for (const o of list) {
    const ada = peta.get(o.name.toLowerCase());
    if (!ada) {
      await conn.query("INSERT INTO menu_options (menu_id, name, extra_price) VALUES (?, ?, ?)", [menuId, o.name, o.extra_price]);
      berubah = true;
      continue;
    }
    dipakai.add(ada.id);
    if (ada.name !== o.name || ada.extra_price !== o.extra_price || !ada.is_active) {
      await conn.query("UPDATE menu_options SET name = ?, extra_price = ?, is_active = TRUE WHERE id = ?", [o.name, o.extra_price, ada.id]);
      berubah = true;
    }
  }
  const hilang = lama.filter((o) => o.is_active && !dipakai.has(o.id)).map((o) => o.id);
  if (hilang.length) await conn.query("UPDATE menu_options SET is_active = FALSE WHERE id IN (?)", [hilang]);
  return berubah || hilang.length > 0;
}

const satu = async (merchantId: number, id: number) => (await bacaMenu(merchantId, ["x.id = ?"], [id]))[0];

export async function buatMenu(userId: number, input: z.infer<typeof menuSchema>): Promise<MerchantMenu> {
  const mid = await idToko(userId);
  const id = await dalamTransaksi(async (conn) => {
    const sets = await kolomMenu(conn, mid, input, null);
    const [r] = await conn.query<ResultSetHeader>("INSERT INTO menus SET ?", [
      { ...sets, merchant_id: mid, quota_today: input.daily_quota, stock_date: hariIniWib() },
    ]);
    if (input.options.length) {
      await conn.query("INSERT INTO menu_options (menu_id, name, extra_price) VALUES ?", [input.options.map((o) => [r.insertId, o.name, o.extra_price])]);
    }
    return r.insertId;
  });
  return satu(mid, id);
}

// daily_quota hanya berlaku mulai hari berikutnya (D6); kolom sistem tidak pernah dari klien
export async function ubahMenu(userId: number, idRaw: unknown, input: MenuInput): Promise<MerchantMenu> {
  const id = menuId(idRaw);
  const mid = await idToko(userId);
  if (Object.keys(input).length === 0) throw new AppError(400, "VALIDATION_ERROR", "Tidak ada data yang diubah.");
  await dalamTransaksi(async (conn) => {
    await segarkanKuota(conn, mid, hariIniWib());
    const lama = await kunciMenu(conn, mid, id);
    const sets = await kolomMenu(conn, mid, input, lama);
    const opsiBerubah = input.options ? await sinkronOpsi(conn, id, input.options) : false;
    const cols = Object.keys(sets);
    // kolom yang berubah menggeser updated_at otomatis; perubahan opsi saja digeser eksplisit (D7)
    const set = [...cols.map((c) => `${c} = ?`), ...(opsiBerubah ? ["updated_at = CURRENT_TIMESTAMP"] : [])];
    if (set.length) await conn.query(`UPDATE menus SET ${set.join(", ")} WHERE id = ?`, [...cols.map((c) => sets[c]), id]);
  });
  return satu(mid, id);
}

// Soft delete (BE-11): baris tetap untuk order_items (FK RESTRICT) dan laporan; hilang dari semua rute penjual
export async function hapusMenu(userId: number, idRaw: unknown): Promise<void> {
  const id = menuId(idRaw);
  const mid = await idToko(userId);
  await dalamTransaksi(async (conn) => {
    const [r] = await conn.query<ResultSetHeader>(
      "UPDATE menus SET deleted_at = UTC_TIMESTAMP(), is_active = FALSE WHERE id = ? AND merchant_id = ? AND deleted_at IS NULL",
      [id, mid],
    );
    if (r.affectedRows === 0) throw menuTidakAda();
  });
}

// D5: satu transaksi, baris menu dikunci (sama dengan checkout F06) → tanpa lost update, tidak pernah < terjual + ditahan.
// updated_at tidak digeser (D7). Aturan di aplikasi karena TiDB tidak menegakkan CHECK.
export async function ubahKuota(userId: number, idRaw: unknown, input: KuotaInput): Promise<MerchantMenu> {
  const id = menuId(idRaw);
  const mid = await idToko(userId);
  await dalamTransaksi(async (conn) => {
    await segarkanKuota(conn, mid, hariIniWib());
    const m = await kunciMenu(conn, mid, id);
    const baru: number = input.delta !== undefined ? m.quota_today + input.delta : input.quota_today!;
    if (baru > 10_000) throw invalidField("quota_today", "Kuota hari ini maksimal 10.000.");
    if (baru < 0) throw new AppError(409, "CONFLICT", "Kuota tidak bisa kurang dari 0.");
    const dipesan: number = m.sold_today + m.held_today;
    if (baru < dipesan) throw new AppError(409, "CONFLICT", `Kuota tidak bisa di bawah porsi yang sudah dipesan (${dipesan}).`);
    await conn.query("UPDATE menus SET quota_today = ?, updated_at = updated_at WHERE id = ?", [baru, id]);
  });
  return satu(mid, id);
}
