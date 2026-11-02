import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { sedangBuka } from "../admin/summary";
import { AppError } from "../http/errors";
import { hariIniWib } from "../merchant/kuota";
import { menuId, menuTidakAda } from "../merchant/menus";
import { Halaman, KatalogQuery } from "./schemas";

// Katalog publik (C-05, C-06). Hanya SELECT: tidak ada UPDATE/FOR UPDATE di modul ini (R-12).

export type MenuCard = {
  id: number; name: string; image_url: string | null; price: number; unit_label: string;
  category: { id: number; name: string; slug: string };
  merchant: { id: number; slug: string; business_name: string; is_open: boolean };
  available: number; badge: "sold_out" | "preorder" | "low_stock" | "available";
  rating_avg: number; rating_count: number; is_favorite: boolean;
};

// Satu sumber "sekarang" untuk jam buka & tanggal stok; test menggantinya agar tidak bergantung jam nyata
export const jam = { sekarang: () => Date.now() };

// "HH:MM:00" WIB; detik dibuang agar sama persis dengan sedangBuka() yang membandingkan per menit
export const jamWib = (ms: number): string => `${new Date(ms + 7 * 3600e3).toISOString().slice(11, 16)}:00`;

// D1 (R-14, BE-11): menu aktif & belum terhapus, toko terverifikasi, pemilik aktif
const TOKO_TAMPIL = "m.verification_status = 'verified' AND u.is_active";
export const TAMPIL = `x.is_active AND x.deleted_at IS NULL AND ${TOKO_TAMPIL}`;

// D2: saklar + jam WIB, sama dengan sedangBuka() (tepat jam tutup = tutup; buka > tutup = lewat tengah malam). 4 parameter jam.
export const BUKA = `m.is_open AND (CASE WHEN m.open_time <= m.close_time THEN ? >= m.open_time AND ? < m.close_time
  ELSE ? >= m.open_time OR ? < m.close_time END)`;

// D5: proyeksi reset harian (aturan `<` sama dengan segarkanKuota) tanpa menulis; 1 parameter tanggal WIB
export const SISA = `GREATEST(CASE WHEN x.stock_date IS NULL OR x.stock_date < ? THEN x.daily_quota
  ELSE x.quota_today - x.sold_today - x.held_today END, 0)`;

export const DARI = `menus x JOIN merchants m ON m.id = x.merchant_id JOIN users u ON u.id = m.user_id
  JOIN categories c ON c.id = x.category_id`;

// Kolom kartu + is_favorite; parameter: tanggal (SISA), lalu userId (LEFT JOIN favorites; null = tidak pernah cocok)
export const KOLOM_KARTU = `x.id, x.name, x.image_url, x.price, x.unit_label, x.is_preorder, x.rating_avg, x.rating_count,
  c.id AS c_id, c.name AS c_name, c.slug AS c_slug, m.id AS m_id, m.slug AS m_slug, m.business_name, m.is_open, m.open_time, m.close_time,
  ${SISA} AS available, f.user_id IS NOT NULL AS fav`;
export const JOIN_FAVORIT = "LEFT JOIN favorites f ON f.menu_id = x.id AND f.user_id = ?";

const badge = (available: number, preorder: boolean): MenuCard["badge"] =>
  available <= 0 ? "sold_out" : preorder ? "preorder" : available <= 10 ? "low_stock" : "available";

export const tokoBuka = (r: RowDataPacket, ms: number) => Boolean(r.is_open) && sedangBuka(ms, String(r.open_time), String(r.close_time));

// Mapper publik D6: daftar kunci eksplisit, tidak pernah `...row` (R-11)
export function kartu(r: RowDataPacket, ms: number): MenuCard {
  const available = Number(r.available);
  return {
    id: r.id, name: r.name, image_url: r.image_url, price: r.price, unit_label: r.unit_label,
    category: { id: r.c_id, name: r.c_name, slug: r.c_slug },
    merchant: { id: r.m_id, slug: r.m_slug, business_name: r.business_name, is_open: tokoBuka(r, ms) },
    available, badge: badge(available, Boolean(r.is_preorder)),
    rating_avg: Number(r.rating_avg), rating_count: r.rating_count, is_favorite: Boolean(r.fav),
  };
}

const URUT: Record<KatalogQuery["sort"], string> = {
  popular: "x.sold_total DESC",
  rating: "x.rating_avg DESC, x.rating_count DESC",
  price_asc: "x.price ASC",
  price_desc: "x.price DESC",
  newest: "x.id DESC",
};

// Daftar/pencarian: 1 kueri data + 1 COUNT (tanpa N+1)
export async function daftarKatalog(q: KatalogQuery, userId: number | null) {
  const ms = jam.sekarang();
  const now = jamWib(ms);
  const hari = hariIniWib(new Date(ms));
  // filter toko (halaman profil, D3) tetap menampilkan menu toko tutup; daftar/pencarian umum hanya toko buka (D2)
  const where = q.merchant ? [TAMPIL] : [TAMPIL, BUKA];
  const args: unknown[] = q.merchant ? [] : [now, now, now, now];
  if (q.q) {
    // shortcut: pencarian LIKE memindai semua menu tampil; ganti FULLTEXT/indeks bila menu > 10.000 atau p95 > 300 ms
    const pola = `%${q.q.replace(/[\\%_]/g, "\\$&")}%`;
    where.push("(LOWER(x.name) LIKE LOWER(?) OR LOWER(m.business_name) LIKE LOWER(?))");
    args.push(pola, pola);
  }
  if (q.category) {
    where.push("c.slug = ?");
    args.push(q.category);
  }
  if (q.merchant) {
    where.push("m.slug = ?");
    args.push(q.merchant);
  }
  if (q.pickup_point_id) {
    where.push(`EXISTS (SELECT 1 FROM merchant_pickup_points mp JOIN pickup_points p ON p.id = mp.pickup_point_id
      WHERE mp.merchant_id = m.id AND p.id = ? AND p.is_active)`);
    args.push(q.pickup_point_id);
  }
  const syarat = where.join(" AND ");
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${KOLOM_KARTU} FROM ${DARI} ${JOIN_FAVORIT} WHERE ${syarat}
     ORDER BY ${SISA} <= 0, ${URUT[q.sort]}, x.id DESC LIMIT ? OFFSET ?`,
    [hari, userId, ...args, hari, q.limit, (q.page - 1) * q.limit],
  );
  const [c] = await db.query<RowDataPacket[]>(`SELECT COUNT(*) AS total FROM ${DARI} WHERE ${syarat}`, args);
  return { data: rows.map((r) => kartu(r, ms)), meta: { page: q.page, limit: q.limit, total: Number(c[0].total) } };
}

const hhmm = (t: unknown) => String(t).slice(0, 5);

export async function titikTemu(merchantId: number): Promise<{ id: number; name: string; description: string | null }[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT p.id, p.name, p.description FROM merchant_pickup_points mp JOIN pickup_points p ON p.id = mp.pickup_point_id
     WHERE mp.merchant_id = ? AND p.is_active ORDER BY p.name`,
    [merchantId],
  );
  return rows.map((p) => ({ id: p.id, name: p.name, description: p.description }));
}

// D7: TAMPIL tanpa BUKA (toko tutup tetap 200, D3); 3 kueri: menu, opsi aktif, titik temu
export async function detailMenu(idRaw: unknown, userId: number | null) {
  const id = menuId(idRaw);
  const ms = jam.sekarang();
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${KOLOM_KARTU}, x.description, x.min_order_qty, x.prep_minutes, x.preorder_days, m.logo_url
     FROM ${DARI} ${JOIN_FAVORIT} WHERE x.id = ? AND ${TAMPIL}`,
    [hariIniWib(new Date(ms)), userId, id],
  );
  const r = rows[0];
  if (!r) throw menuTidakAda();
  const [[ops], pickup_points] = await Promise.all([
    db.query<RowDataPacket[]>("SELECT id, name, extra_price FROM menu_options WHERE menu_id = ? AND is_active ORDER BY id", [id]),
    titikTemu(r.m_id),
  ]);
  const k = kartu(r, ms);
  return {
    ...k, description: r.description,
    options: ops.map((o) => ({ id: o.id, name: o.name, extra_price: o.extra_price })),
    min_order_qty: r.min_order_qty, prep_minutes: r.prep_minutes, is_preorder: Boolean(r.is_preorder), preorder_days: r.preorder_days,
    merchant: { ...k.merchant, logo_url: r.logo_url, open_time: hhmm(r.open_time), close_time: hhmm(r.close_time), pickup_points },
  };
}

// D11: menu harus lolos TAMPIL; nama pembeli disamarkan 2 karakter + "***"
export async function ulasanMenu(idRaw: unknown, h: Halaman) {
  const id = menuId(idRaw);
  const [ada] = await db.query<RowDataPacket[]>(`SELECT x.id FROM ${DARI} WHERE x.id = ? AND ${TAMPIL}`, [id]);
  if (!ada[0]) throw menuTidakAda();
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT r.rating, r.comment, u.full_name, r.created_at FROM reviews r JOIN users u ON u.id = r.customer_id
     WHERE r.menu_id = ? ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`,
    [id, h.limit, (h.page - 1) * h.limit],
  );
  const [c] = await db.query<RowDataPacket[]>("SELECT COUNT(*) AS total FROM reviews WHERE menu_id = ?", [id]);
  return {
    data: rows.map((r) => ({
      rating: r.rating, comment: r.comment,
      customer_name: `${Array.from(String(r.full_name).trim()).slice(0, 2).join("")}***`, created_at: r.created_at,
    })),
    meta: { page: h.page, limit: h.limit, total: Number(c[0].total) },
  };
}

// D12: tanpa alamat, WA, user_id, status verifikasi; 2 kueri
export async function profilToko(slug: string) {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT m.id, m.slug, m.business_name, m.description, m.logo_url, m.is_open, m.open_time, m.close_time, m.rating_avg, m.rating_count,
       t.id AS t_id, t.name AS t_name
     FROM merchants m JOIN users u ON u.id = m.user_id JOIN merchant_types t ON t.id = m.merchant_type_id
     WHERE m.slug = ? AND ${TOKO_TAMPIL}`,
    [slug],
  );
  const m = rows[0];
  if (!m) throw new AppError(404, "NOT_FOUND", "Toko tidak ditemukan.");
  return {
    id: m.id, slug: m.slug, business_name: m.business_name, description: m.description, logo_url: m.logo_url,
    merchant_type: { id: m.t_id, name: m.t_name }, is_open: tokoBuka(m, jam.sekarang()),
    open_time: hhmm(m.open_time), close_time: hhmm(m.close_time), rating_avg: Number(m.rating_avg), rating_count: m.rating_count,
    pickup_points: await titikTemu(m.id),
  };
}
