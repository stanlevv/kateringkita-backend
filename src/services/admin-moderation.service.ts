// Isi file: moderasi konten oleh admin: daftar dan sembunyikan/tampilkan ulasan, daftar dan turunkan/pulihkan menu,
// serta hapus satu foto menu. Alurnya routes/admin.ts → handlers/admin.handler.ts → file ini → database. Semua tingkat
// admin boleh melihat daftar; aksi (POST) hanya untuk admin ops dan super. Setiap aksi yang mengubah data dicatat di
// log audit. Menangguhkan toko ada di admin-merchant.service.
//
// Istilah moderasi:
// - Sembunyikan ulasan: ulasan tidak tampil di aplikasi dan tidak ikut dihitung di rating menu/toko; datanya tetap ada.
// - Turunkan menu (takedown): menu dinonaktifkan dan diberi tanda moderasi, sehingga penjual tidak bisa
//   mengaktifkannya sendiri. Pulihkan (restore) hanya menghapus tanda itu; menu tetap nonaktif sampai penjual
//   mengaktifkannya lagi.
import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { AppError } from "../utils/errors";
import { recordAudit, withTransaction, lockRow } from "./admin-audit.service";
import { likePattern } from "./order.service";
import { parseGallery } from "./merchant-menu.service";
import { recalculateRatings } from "./review.service";

// Filter daftar moderasi: kata kunci, status (`active` = belum dimoderasi, `moderated` = sudah), dan halaman.
type Filter = { q?: string; status?: string; page: number; limit: number };

// Filter status menjadi syarat SQL pada kolom tanda moderasi (kolom terisi = sudah dimoderasi).
function statusFilter(status: string | undefined, column: string) {
  if (status === undefined) return null;
  if (status !== "active" && status !== "moderated") {
    throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", {
      status: ["Status harus active atau moderated."],
    });
  }
  return `${column} IS ${status === "moderated" ? "NOT " : ""}NULL`;
}

// Menjalankan query daftar satu halaman beserta hitungan totalnya, dengan syarat WHERE yang sama.
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
// Ulasan beserta menu, toko, nama pembeli, dan kode pesanannya.
const REVIEW_FROM_SQL = `FROM reviews r JOIN menus x ON x.id = r.menu_id JOIN merchants m ON m.id = x.merchant_id
  JOIN users u ON u.id = r.customer_id JOIN orders o ON o.id = r.order_id`;
const REVIEW_COLUMNS = `r.id, r.rating, r.comment, r.created_at, r.hidden_at, r.hidden_reason, x.id AS menu_id, x.name AS menu_name,
  m.id AS merchant_id, m.business_name, u.full_name AS customer_name, o.code AS order_code`;
// Baris query menjadi bentuk JSON ulasan untuk panel admin.
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

/**
 * Daftar ulasan untuk moderasi, terbaru dulu.
 * @param filter `q` = kata kunci di komentar, nama menu, atau nama toko; `status` = `active`/`moderated`; halaman
 * @returns `{ data, meta: { page, limit, total } }`
 * @throws 400 status selain `active` atau `moderated`
 */
export async function listAdminReviews(filter: Filter) {
  // 1. Susun syarat dari status dan kata kunci.
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
  // 2. Ambil satu halaman beserta totalnya.
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

/**
 * Menyembunyikan atau menampilkan lagi satu ulasan, lalu menghitung ulang rating menu dan tokonya. Bila ulasan sudah
 * dalam keadaan tujuan, tidak ada perubahan dan tidak ada log. Dicatat di log audit `review.hide` / `review.unhide`.
 * @param adminId id admin yang memoderasi
 * @param idRaw   id ulasan dari URL
 * @param hide    `true` untuk menyembunyikan, `false` untuk menampilkan lagi
 * @param reason  alasan (wajib saat menyembunyikan, diperiksa di rute); dikosongkan saat ditampilkan lagi
 * @returns ulasan sesudah diubah
 * @throws 404 ulasan tidak ditemukan
 */
export async function moderateReview(adminId: number, idRaw: unknown, hide: boolean, reason: string | null) {
  const id = await withTransaction(async (conn) => {
    // 1. Kunci ulasan; bila sudah dalam keadaan tujuan, selesai tanpa log.
    const review = await lockRow(conn, "reviews", idRaw, { notFound: "Ulasan tidak ditemukan." });
    if ((review.hidden_at !== null) === hide) return review.id;
    // 2. Isi atau kosongkan tanda sembunyi, lalu hitung ulang rating menu dan toko tanpa ulasan tersembunyi.
    await conn.query("UPDATE reviews SET hidden_at = IF(?, UTC_TIMESTAMP(), NULL), hidden_reason = ? WHERE id = ?", [
      hide,
      hide ? reason : null,
      review.id,
    ]);
    const [[menu]] = await conn.query<RowDataPacket[]>("SELECT merchant_id FROM menus WHERE id = ?", [review.menu_id]);
    await recalculateRatings(conn, [review.menu_id], menu.merchant_id);
    // 3. Catat keadaan sebelum dan sesudah beserta alasannya di log audit.
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
  // 4. Setelah transaksi selesai, baca ulang ulasan dalam bentuk daftar.
  const [[row]] = await db.query<RowDataPacket[]>(`SELECT ${REVIEW_COLUMNS} ${REVIEW_FROM_SQL} WHERE r.id = ?`, [id]);
  return mapReview(row);
}

// --- Menu ---
// Menu beserta nama tokonya.
const MENU_FROM_SQL = "FROM menus x JOIN merchants m ON m.id = x.merchant_id";
const MENU_COLUMNS = `x.id, x.name, x.price, x.image_url, x.gallery, x.is_active, x.moderated_at, x.moderation_reason, x.created_at,
  m.id AS merchant_id, m.business_name`;
// Baris query menjadi bentuk JSON menu untuk panel admin (galeri foto diurai dari JSON).
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

/**
 * Daftar menu (yang belum dihapus penjual) untuk moderasi, terbaru dulu.
 * @param filter `q` = kata kunci di nama menu atau nama toko; `status` = `active`/`moderated`; halaman
 * @returns `{ data, meta: { page, limit, total } }`
 * @throws 400 status selain `active` atau `moderated`
 */
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

/**
 * Menurunkan (takedown) atau memulihkan (restore) satu menu. Turunkan = menu dinonaktifkan dan ditandai sehingga
 * penjual tidak bisa mengaktifkannya sendiri. Pulihkan = tanda dihapus, tetapi menu tetap nonaktif sampai penjual
 * mengaktifkannya. Bila sudah dalam keadaan tujuan, tidak ada perubahan dan tidak ada log. Dicatat di log audit
 * `menu.takedown` / `menu.restore`.
 * @param adminId  id admin yang memoderasi
 * @param idRaw    id menu dari URL
 * @param takedown `true` untuk menurunkan, `false` untuk memulihkan
 * @param reason   alasan (wajib saat menurunkan, diperiksa di rute); dikosongkan saat dipulihkan
 * @returns menu sesudah diubah
 * @throws 404 menu tidak ada atau sudah dihapus penjual
 */
export async function moderateMenu(adminId: number, idRaw: unknown, takedown: boolean, reason: string | null) {
  const id = await withTransaction(async (conn) => {
    // 1. Kunci menu; bila sudah dalam keadaan tujuan, selesai tanpa log.
    const menu = await lockRow(conn, "menus", idRaw, {
      where: "deleted_at IS NULL",
      notFound: "Menu tidak ditemukan.",
    });
    if ((menu.moderated_at !== null) === takedown) return menu.id;
    // 2. Isi atau hapus tanda moderasi; saat diturunkan, menu sekaligus dinonaktifkan.
    await conn.query(
      `UPDATE menus SET moderated_at = IF(?, UTC_TIMESTAMP(), NULL), moderation_reason = ?${takedown ? ", is_active = FALSE" : ""} WHERE id = ?`,
      [takedown, takedown ? reason : null, menu.id],
    );
    // 3. Catat tanda moderasi, status aktif, dan alasan sebelum/sesudah di log audit.
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
  // 4. Baca ulang menu dalam bentuk daftar.
  const [[row]] = await db.query<RowDataPacket[]>(`SELECT ${MENU_COLUMNS} ${MENU_FROM_SQL} WHERE x.id = ?`, [id]);
  return mapMenu(row);
}

// shortcut: objek di R2 tidak dihapus (sama dengan createUpload)
/**
 * Menghapus satu foto menu yang melanggar tanpa menurunkan menunya (menu tetap dijual). Bila foto utama yang dihapus,
 * foto tambahan pertama naik menjadi foto utama supaya kartu katalog tidak kosong. Dicatat di log audit
 * `menu.photo_remove` dan pemilik toko mendapat notifikasi tipe `moderation` berisi alasannya.
 * @param adminId id admin yang menghapus
 * @param idRaw   id menu dari URL
 * @param url     alamat foto yang dihapus (foto utama atau salah satu foto tambahan)
 * @param reason  alasan penghapusan (wajib, diperiksa di rute)
 * @returns menu sesudah foto dihapus
 * @throws 404 menu tidak ada, sudah dihapus penjual, atau foto itu bukan milik menu ini
 */
export async function removeMenuPhoto(adminId: number, idRaw: unknown, url: string, reason: string) {
  const id = await withTransaction(async (conn) => {
    // 1. Kunci menu yang belum dihapus.
    const menu = await lockRow(conn, "menus", idRaw, {
      where: "deleted_at IS NULL",
      notFound: "Menu tidak ditemukan.",
    });
    // 2. Hitung susunan foto sesudahnya: foto utama diganti foto tambahan pertama, atau foto tambahan dibuang.
    const before = { image_url: menu.image_url as string | null, gallery: parseGallery(menu.gallery) };
    let after: typeof before;
    if (before.image_url === url) after = { image_url: before.gallery[0] ?? null, gallery: before.gallery.slice(1) };
    else if (before.gallery.includes(url))
      after = { image_url: before.image_url, gallery: before.gallery.filter((photoUrl) => photoUrl !== url) };
    else throw new AppError(404, "NOT_FOUND", "Foto tidak ditemukan di menu ini.");
    // 3. Simpan susunan foto baru (galeri kosong disimpan NULL) dan catat di log audit.
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
    // 4. Kabari pemilik toko lewat notifikasi (halaman Notifikasi dasbor penjual).
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
  // 5. Baca ulang menu dalam bentuk daftar.
  const [[row]] = await db.query<RowDataPacket[]>(`SELECT ${MENU_COLUMNS} ${MENU_FROM_SQL} WHERE x.id = ?`, [id]);
  return mapMenu(row);
}
