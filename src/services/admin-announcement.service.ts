import { ResultSetHeader, RowDataPacket } from "mysql2";
import db from "../config/db";
import { AnnouncementInput } from "../dto/admin.dto";
import { recordAudit, withTransaction } from "./admin-audit.service";
import { MERCHANT_VISIBLE } from "./catalog.service";

// Broadcast: pengumuman admin → notifikasi tipe "info" ke semua pengguna aktif sesuai peran (admin tidak ikut)
export async function sendAnnouncement(adminId: number, announcement: AnnouncementInput) {
  const roles = announcement.audience === "all" ? ["customer", "merchant"] : [announcement.audience];
  return withTransaction(async (conn) => {
    const [result] = await conn.query<ResultSetHeader>(
      `INSERT INTO notifications (user_id, type, title, body, data, created_at)
       SELECT id, 'info', ?, ?, JSON_OBJECT('audience', ?), UTC_TIMESTAMP() FROM users WHERE is_active AND role IN (?)`,
      [announcement.title, announcement.body, announcement.audience, roles],
    );
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

// Broadcast: promo toko yang aktif dan belum berakhir → notifikasi tipe "promo" ke pembeli yang memfavoritkan menu toko itu.
// AUD-43: satu notifikasi per promo per penerima per 24 jam, jadi mati-nyala berulang tidak membanjiri pemfavorit
export async function notifyMerchantPromo(promo: RowDataPacket) {
  // AUD-27: kode tersembunyi (is_public = 0) hanya dibagikan penjual sendiri, jangan disiarkan
  if (!promo.is_active || !promo.is_public || new Date(promo.ends_at).getTime() <= Date.now()) return;
  // AUD-33: toko yang tidak tampil di katalog (suspend, belum verifikasi, pemilik nonaktif) tidak boleh menyiarkan promo
  const [[merchant]] = await db.query<RowDataPacket[]>(
    `SELECT m.business_name FROM merchants m JOIN users u ON u.id = m.user_id WHERE m.id = ? AND ${MERCHANT_VISIBLE}`,
    [promo.merchant_id],
  );
  if (!merchant) return;
  const title = `Promo baru dari ${merchant.business_name}`.slice(0, 120);
  const body = `Pakai kode ${promo.code}${promo.description ? `: ${promo.description}` : " saat checkout."}`.slice(
    0,
    255,
  );
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
