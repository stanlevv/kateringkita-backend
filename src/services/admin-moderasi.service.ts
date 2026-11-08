import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { AppError } from "../utils/errors";
import { catat, dalamTransaksi, kunci } from "./admin-audit.service";
import { pola } from "./pesanan.service";
import { hitungUlangRating } from "./ulasan.service";

// F19 moderasi admin: sembunyikan ulasan & turunkan menu (suspend toko sudah ada di admin-merchant F18). Semua aksi dicatat audit.
type Filter = { q?: string; status?: string; page: number; limit: number };

function statusFilter(status: string | undefined, kolom: string) {
  if (status === undefined) return null;
  if (status !== "active" && status !== "moderated") {
    throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", { status: ["Status harus active atau moderated."] });
  }
  return `${kolom} IS ${status === "moderated" ? "NOT " : ""}NULL`;
}

async function halaman(select: string, from: string, where: string[], args: unknown[], urut: string, f: Filter) {
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [[n]] = await db.query<RowDataPacket[]>(`SELECT COUNT(*) AS n ${from} ${w}`, args);
  const [rows] = await db.query<RowDataPacket[]>(`SELECT ${select} ${from} ${w} ORDER BY ${urut} LIMIT ? OFFSET ?`, [...args, f.limit, (f.page - 1) * f.limit]);
  return { rows, meta: { page: f.page, limit: f.limit, total: Number(n.n) } };
}

// --- Ulasan ---
const DARI_ULASAN = `FROM reviews r JOIN menus x ON x.id = r.menu_id JOIN merchants m ON m.id = x.merchant_id
  JOIN users u ON u.id = r.customer_id JOIN orders o ON o.id = r.order_id`;
const KOLOM_ULASAN = `r.id, r.rating, r.comment, r.created_at, r.hidden_at, r.hidden_reason, x.id AS menu_id, x.name AS menu_name,
  m.id AS merchant_id, m.business_name, u.full_name AS customer_name, o.code AS order_code`;
const petaUlasan = (r: RowDataPacket) => ({
  id: r.id, rating: r.rating, comment: r.comment, created_at: r.created_at, hidden: r.hidden_at !== null, hidden_at: r.hidden_at,
  hidden_reason: r.hidden_reason, menu: { id: r.menu_id, name: r.menu_name }, merchant: { id: r.merchant_id, business_name: r.business_name },
  customer_name: r.customer_name, order_code: r.order_code,
});

export async function daftarUlasanAdmin(f: Filter) {
  const where: string[] = [];
  const args: unknown[] = [];
  const s = statusFilter(f.status, "r.hidden_at");
  if (s) where.push(s);
  if (f.q) {
    where.push("(LOWER(r.comment) LIKE LOWER(?) OR LOWER(x.name) LIKE LOWER(?) OR LOWER(m.business_name) LIKE LOWER(?))");
    args.push(pola(f.q), pola(f.q), pola(f.q));
  }
  const { rows, meta } = await halaman(KOLOM_ULASAN, DARI_ULASAN, where, args, "r.created_at DESC, r.id DESC", f);
  return { data: rows.map(petaUlasan), meta };
}

export async function moderasiUlasan(adminId: number, idRaw: unknown, sembunyi: boolean, reason: string | null) {
  const id = await dalamTransaksi(async (conn) => {
    const r = await kunci(conn, "reviews", idRaw, { notFound: "Ulasan tidak ditemukan." });
    if ((r.hidden_at !== null) === sembunyi) return r.id; // sudah dalam keadaan tujuan: tanpa log
    await conn.query("UPDATE reviews SET hidden_at = IF(?, UTC_TIMESTAMP(), NULL), hidden_reason = ? WHERE id = ?", [sembunyi, sembunyi ? reason : null, r.id]);
    const [[x]] = await conn.query<RowDataPacket[]>("SELECT merchant_id FROM menus WHERE id = ?", [r.menu_id]);
    await hitungUlangRating(conn, [r.menu_id], x.merchant_id);
    await catat(conn, {
      adminId, action: sembunyi ? "review.hide" : "review.unhide", targetType: "review", targetId: r.id,
      before: { hidden: !sembunyi, reason: r.hidden_reason }, after: { hidden: sembunyi, reason: sembunyi ? reason : null },
    });
    return r.id;
  });
  const [[r]] = await db.query<RowDataPacket[]>(`SELECT ${KOLOM_ULASAN} ${DARI_ULASAN} WHERE r.id = ?`, [id]);
  return petaUlasan(r);
}

// --- Menu ---
const DARI_MENU = "FROM menus x JOIN merchants m ON m.id = x.merchant_id";
const KOLOM_MENU = `x.id, x.name, x.price, x.image_url, x.is_active, x.moderated_at, x.moderation_reason, x.created_at,
  m.id AS merchant_id, m.business_name`;
const petaMenu = (x: RowDataPacket) => ({
  id: x.id, name: x.name, price: x.price, image_url: x.image_url, is_active: Boolean(x.is_active), moderated: x.moderated_at !== null,
  moderated_at: x.moderated_at, moderation_reason: x.moderation_reason, created_at: x.created_at,
  merchant: { id: x.merchant_id, business_name: x.business_name },
});

export async function daftarMenuAdmin(f: Filter) {
  const where = ["x.deleted_at IS NULL"];
  const args: unknown[] = [];
  const s = statusFilter(f.status, "x.moderated_at");
  if (s) where.push(s);
  if (f.q) {
    where.push("(LOWER(x.name) LIKE LOWER(?) OR LOWER(m.business_name) LIKE LOWER(?))");
    args.push(pola(f.q), pola(f.q));
  }
  const { rows, meta } = await halaman(KOLOM_MENU, DARI_MENU, where, args, "x.id DESC", f);
  return { data: rows.map(petaMenu), meta };
}

// Turunkan: nonaktif + ditandai, penjual tidak bisa mengaktifkan sendiri. Pulihkan: tanda dihapus, menu tetap nonaktif sampai penjual mengaktifkan.
export async function moderasiMenu(adminId: number, idRaw: unknown, turun: boolean, reason: string | null) {
  const id = await dalamTransaksi(async (conn) => {
    const x = await kunci(conn, "menus", idRaw, { where: "deleted_at IS NULL", notFound: "Menu tidak ditemukan." });
    if ((x.moderated_at !== null) === turun) return x.id;
    await conn.query(
      `UPDATE menus SET moderated_at = IF(?, UTC_TIMESTAMP(), NULL), moderation_reason = ?${turun ? ", is_active = FALSE" : ""} WHERE id = ?`,
      [turun, turun ? reason : null, x.id],
    );
    await catat(conn, {
      adminId, action: turun ? "menu.takedown" : "menu.restore", targetType: "menu", targetId: x.id,
      before: { moderated: !turun, is_active: Boolean(x.is_active), reason: x.moderation_reason },
      after: { moderated: turun, is_active: turun ? false : Boolean(x.is_active), reason: turun ? reason : null },
    });
    return x.id;
  });
  const [[x]] = await db.query<RowDataPacket[]>(`SELECT ${KOLOM_MENU} ${DARI_MENU} WHERE x.id = ?`, [id]);
  return petaMenu(x);
}
