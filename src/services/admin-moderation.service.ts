import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { AppError } from "../utils/errors";
import { recordAudit, withTransaction, lockRow } from "./admin-audit.service";
import { likePattern } from "./order.service";
import { parseGallery } from "./merchant-menu.service";
import { recalculateRatings } from "./review.service";

// F19 moderasi admin: sembunyikan ulasan & turunkan menu (suspend toko sudah ada di admin-merchant F18). Semua aksi dicatat audit.
type Filter = { q?: string; status?: string; page: number; limit: number };

function statusFilter(status: string | undefined, column: string) {
  if (status === undefined) return null;
  if (status !== "active" && status !== "moderated") {
    throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", {
      status: ["Status harus active atau moderated."],
    });
  }
  return `${column} IS ${status === "moderated" ? "NOT " : ""}NULL`;
}

async function loadPage(
  select: string,
  from: string,
  where: string[],
  args: unknown[],
  orderBy: string,
  filter: Filter,
) {
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [[countRow]] = await db.query<RowDataPacket[]>(`SELECT COUNT(*) AS n ${from} ${whereSql}`, args);
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${select} ${from} ${whereSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    [...args, filter.limit, (filter.page - 1) * filter.limit],
  );
  return { rows, meta: { page: filter.page, limit: filter.limit, total: Number(countRow.n) } };
}

// --- Ulasan ---
const REVIEW_FROM_SQL = `FROM reviews r JOIN menus x ON x.id = r.menu_id JOIN merchants m ON m.id = x.merchant_id
  JOIN users u ON u.id = r.customer_id JOIN orders o ON o.id = r.order_id`;
const REVIEW_COLUMNS = `r.id, r.rating, r.comment, r.created_at, r.hidden_at, r.hidden_reason, x.id AS menu_id, x.name AS menu_name,
  m.id AS merchant_id, m.business_name, u.full_name AS customer_name, o.code AS order_code`;
const mapReview = (row: RowDataPacket) => ({
  id: row.id,
  rating: row.rating,
  comment: row.comment,
  created_at: row.created_at,
  hidden: row.hidden_at !== null,
  hidden_at: row.hidden_at,
  hidden_reason: row.hidden_reason,
  menu: { id: row.menu_id, name: row.menu_name },
  merchant: { id: row.merchant_id, business_name: row.business_name },
  customer_name: row.customer_name,
  order_code: row.order_code,
});

export async function listAdminReviews(filter: Filter) {
  const where: string[] = [];
  const args: unknown[] = [];
  const condition = statusFilter(filter.status, "r.hidden_at");
  if (condition) where.push(condition);
  if (filter.q) {
    where.push(
      "(LOWER(r.comment) LIKE LOWER(?) OR LOWER(x.name) LIKE LOWER(?) OR LOWER(m.business_name) LIKE LOWER(?))",
    );
    args.push(likePattern(filter.q), likePattern(filter.q), likePattern(filter.q));
  }
  const { rows, meta } = await loadPage(
    REVIEW_COLUMNS,
    REVIEW_FROM_SQL,
    where,
    args,
    "r.created_at DESC, r.id DESC",
    filter,
  );
  return { data: rows.map(mapReview), meta };
}

export async function moderateReview(adminId: number, idRaw: unknown, hide: boolean, reason: string | null) {
  const id = await withTransaction(async (conn) => {
    const review = await lockRow(conn, "reviews", idRaw, { notFound: "Ulasan tidak ditemukan." });
    if ((review.hidden_at !== null) === hide) return review.id; // sudah dalam keadaan tujuan: tanpa log
    await conn.query("UPDATE reviews SET hidden_at = IF(?, UTC_TIMESTAMP(), NULL), hidden_reason = ? WHERE id = ?", [
      hide,
      hide ? reason : null,
      review.id,
    ]);
    const [[menu]] = await conn.query<RowDataPacket[]>("SELECT merchant_id FROM menus WHERE id = ?", [review.menu_id]);
    await recalculateRatings(conn, [review.menu_id], menu.merchant_id);
    await recordAudit(conn, {
      adminId,
      action: hide ? "review.hide" : "review.unhide",
      targetType: "review",
      targetId: review.id,
      before: { hidden: !hide, reason: review.hidden_reason },
      after: { hidden: hide, reason: hide ? reason : null },
    });
    return review.id;
  });
  const [[row]] = await db.query<RowDataPacket[]>(`SELECT ${REVIEW_COLUMNS} ${REVIEW_FROM_SQL} WHERE r.id = ?`, [id]);
  return mapReview(row);
}

// --- Menu ---
const MENU_FROM_SQL = "FROM menus x JOIN merchants m ON m.id = x.merchant_id";
const MENU_COLUMNS = `x.id, x.name, x.price, x.image_url, x.gallery, x.is_active, x.moderated_at, x.moderation_reason, x.created_at,
  m.id AS merchant_id, m.business_name`;
const mapMenu = (row: RowDataPacket) => ({
  id: row.id,
  name: row.name,
  price: row.price,
  image_url: row.image_url,
  gallery: parseGallery(row.gallery),
  is_active: Boolean(row.is_active),
  moderated: row.moderated_at !== null,
  moderated_at: row.moderated_at,
  moderation_reason: row.moderation_reason,
  created_at: row.created_at,
  merchant: { id: row.merchant_id, business_name: row.business_name },
});

export async function listAdminMenus(filter: Filter) {
  const where = ["x.deleted_at IS NULL"];
  const args: unknown[] = [];
  const condition = statusFilter(filter.status, "x.moderated_at");
  if (condition) where.push(condition);
  if (filter.q) {
    where.push("(LOWER(x.name) LIKE LOWER(?) OR LOWER(m.business_name) LIKE LOWER(?))");
    args.push(likePattern(filter.q), likePattern(filter.q));
  }
  const { rows, meta } = await loadPage(MENU_COLUMNS, MENU_FROM_SQL, where, args, "x.id DESC", filter);
  return { data: rows.map(mapMenu), meta };
}

// Turunkan: nonaktif + ditandai, penjual tidak bisa mengaktifkan sendiri. Pulihkan: tanda dihapus, menu tetap nonaktif sampai penjual mengaktifkan.
export async function moderateMenu(adminId: number, idRaw: unknown, takedown: boolean, reason: string | null) {
  const id = await withTransaction(async (conn) => {
    const menu = await lockRow(conn, "menus", idRaw, {
      where: "deleted_at IS NULL",
      notFound: "Menu tidak ditemukan.",
    });
    if ((menu.moderated_at !== null) === takedown) return menu.id;
    await conn.query(
      `UPDATE menus SET moderated_at = IF(?, UTC_TIMESTAMP(), NULL), moderation_reason = ?${takedown ? ", is_active = FALSE" : ""} WHERE id = ?`,
      [takedown, takedown ? reason : null, menu.id],
    );
    await recordAudit(conn, {
      adminId,
      action: takedown ? "menu.takedown" : "menu.restore",
      targetType: "menu",
      targetId: menu.id,
      before: { moderated: !takedown, is_active: Boolean(menu.is_active), reason: menu.moderation_reason },
      after: {
        moderated: takedown,
        is_active: takedown ? false : Boolean(menu.is_active),
        reason: takedown ? reason : null,
      },
    });
    return menu.id;
  });
  const [[row]] = await db.query<RowDataPacket[]>(`SELECT ${MENU_COLUMNS} ${MENU_FROM_SQL} WHERE x.id = ?`, [id]);
  return mapMenu(row);
}

// Hapus satu foto melanggar; menu tetap dijual. Foto utama dihapus → foto tambahan pertama naik jadi foto utama (kartu katalog tidak kosong).
// shortcut: objek di R2 tidak dihapus (sama dengan createUpload)
export async function removeMenuPhoto(adminId: number, idRaw: unknown, url: string, reason: string) {
  const id = await withTransaction(async (conn) => {
    const menu = await lockRow(conn, "menus", idRaw, {
      where: "deleted_at IS NULL",
      notFound: "Menu tidak ditemukan.",
    });
    const before = { image_url: menu.image_url as string | null, gallery: parseGallery(menu.gallery) };
    let after: typeof before;
    if (before.image_url === url) after = { image_url: before.gallery[0] ?? null, gallery: before.gallery.slice(1) };
    else if (before.gallery.includes(url))
      after = { image_url: before.image_url, gallery: before.gallery.filter((photoUrl) => photoUrl !== url) };
    else throw new AppError(404, "NOT_FOUND", "Foto tidak ditemukan di menu ini.");
    await conn.query("UPDATE menus SET image_url = ?, gallery = ? WHERE id = ?", [
      after.image_url,
      after.gallery.length ? JSON.stringify(after.gallery) : null,
      menu.id,
    ]);
    await recordAudit(conn, {
      adminId,
      action: "menu.photo_remove",
      targetType: "menu",
      targetId: menu.id,
      reason,
      before,
      after,
    });
    // kabari pemilik toko (halaman Notifikasi dashboard penjual)
    await conn.query(
      `INSERT INTO notifications (user_id, type, title, body, data, created_at)
       SELECT m.user_id, 'moderation', 'Foto menu dihapus admin', ?, JSON_OBJECT('menu_id', ?), UTC_TIMESTAMP() FROM merchants m WHERE m.id = ?`,
      [
        `Satu foto "${menu.name}" dihapus karena: ${reason}. Menu tetap dijual; unggah foto pengganti bila perlu.`.slice(
          0,
          255,
        ),
        menu.id,
        menu.merchant_id,
      ],
    );
    return menu.id;
  });
  const [[row]] = await db.query<RowDataPacket[]>(`SELECT ${MENU_COLUMNS} ${MENU_FROM_SQL} WHERE x.id = ?`, [id]);
  return mapMenu(row);
}
