// Isi file: pengiriman notifikasi massal (broadcast). Pertama, pengumuman admin (POST /admin/broadcasts, admin ops dan
// super) yang masuk ke tab Info aplikasi; alurnya routes/admin.ts → handlers/admin.handler.ts → file ini → database.
// Kedua, kabar promo toko ke pembeli yang memfavoritkan menu toko itu, dipanggil merchant-promo.service saat promo
// dibuat atau dinyalakan. Notifikasi disimpan di tabel notifications dan dibaca aplikasi lewat /me/notifications.
import { ResultSetHeader, RowDataPacket } from "mysql2";
import db from "../config/db";
import { AnnouncementInput } from "../dto/admin.dto";
import { recordAudit, withTransaction } from "./admin-audit.service";
import { MERCHANT_VISIBLE } from "./catalog.service";

/**
 * Mengirim pengumuman admin sebagai notifikasi tipe `info` ke semua akun aktif sesuai sasaran: `all` = pembeli dan
 * penjual, `customer` = pembeli saja, `merchant` = penjual saja (admin tidak pernah ikut). Dicatat di log audit
 * (`notification.broadcast`) beserta jumlah penerimanya.
 * @param adminId      id admin pengirim
 * @param announcement isi yang sudah diperiksa announcementSchema: sasaran, judul, isi
 * @returns `{ sent }` = jumlah notifikasi yang dibuat
 */
export async function sendAnnouncement(adminId: number, announcement: AnnouncementInput) {
  const roles = announcement.audience === "all" ? ["customer", "merchant"] : [announcement.audience];
  return withTransaction(async (conn) => {
    // 1. Satu INSERT ... SELECT membuat satu notifikasi untuk setiap akun aktif dengan peran sasaran.
    const [result] = await conn.query<ResultSetHeader>(
      `INSERT INTO notifications (user_id, type, title, body, data, created_at)
       SELECT id, 'info', ?, ?, JSON_OBJECT('audience', ?), UTC_TIMESTAMP() FROM users WHERE is_active AND role IN (?)`,
      [announcement.title, announcement.body, announcement.audience, roles],
    );
    // 2. Catat di log audit di transaksi yang sama.
    await recordAudit(conn, {
      adminId,
      action: "notification.broadcast",
      targetType: "notification",
      targetId: announcement.audience,
      after: { ...announcement, sent: result.affectedRows },
    });
    return { sent: result.affectedRows };
  });
}

/**
 * Mengabarkan promo toko sebagai notifikasi tipe `promo` ke pembeli aktif yang memfavoritkan menu toko itu. Tidak
 * mengirim apa pun bila promo tidak aktif, tersembunyi, sudah berakhir, atau tokonya tidak tampil di katalog. Setiap
 * pembeli paling banyak menerima satu notifikasi per kode promo per 24 jam. Tidak dicatat di log audit.
 * @param promo baris promo dari tabel promos (sesudah disimpan)
 * @returns selesai setelah notifikasi dibuat (atau dilewati)
 */
export async function notifyMerchantPromo(promo: RowDataPacket) {
  // 1. Kode tersembunyi (is_public = 0) hanya dibagikan penjual sendiri, jadi tidak disiarkan; promo nonaktif atau
  //    yang sudah berakhir juga tidak.
  if (!promo.is_active || !promo.is_public || new Date(promo.ends_at).getTime() <= Date.now()) return;
  // 2. Toko yang tidak tampil di katalog (ditangguhkan, belum terverifikasi, pemilik nonaktif) tidak boleh menyiarkan.
  const [[merchant]] = await db.query<RowDataPacket[]>(
    `SELECT m.business_name FROM merchants m JOIN users u ON u.id = m.user_id WHERE m.id = ? AND ${MERCHANT_VISIBLE}`,
    [promo.merchant_id],
  );
  if (!merchant) return;
  // 3. Susun judul dan isi, dipotong sesuai panjang kolom notifications.
  const title = `Promo baru dari ${merchant.business_name}`.slice(0, 120);
  const body = `Pakai kode ${promo.code}${promo.description ? `: ${promo.description}` : " saat checkout."}`.slice(
    0,
    255,
  );
  // 4. Satu notifikasi per pembeli pemfavorit, kecuali yang sudah menerima kode ini dalam 24 jam terakhir, supaya
  //    promo yang dimatikan lalu dinyalakan berulang kali tidak membanjiri pembeli.
  await db.query(
    `INSERT INTO notifications (user_id, type, title, body, data, created_at)
     SELECT DISTINCT f.user_id, 'promo', ?, ?, JSON_OBJECT('promo_code', ?, 'merchant_id', ?), UTC_TIMESTAMP()
     FROM favorites f JOIN menus x ON x.id = f.menu_id JOIN users u ON u.id = f.user_id
     WHERE x.merchant_id = ? AND x.deleted_at IS NULL AND u.is_active
       AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = f.user_id AND n.type = 'promo'
         AND JSON_UNQUOTE(JSON_EXTRACT(n.data, '$.promo_code')) = ? AND n.created_at > UTC_TIMESTAMP() - INTERVAL 24 HOUR)`,
    [title, body, promo.code, promo.merchant_id, promo.merchant_id, promo.code],
  );
}
