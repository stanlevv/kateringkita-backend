import { ResultSetHeader, RowDataPacket } from "mysql2";
import db from "../config/db";
import { PengumumanInput } from "../dto/admin.dto";
import { catat, dalamTransaksi } from "./admin-audit.service";

// Broadcast: pengumuman admin → notifikasi tipe "info" ke semua pengguna aktif sesuai peran (admin tidak ikut)
export async function kirimPengumuman(adminId: number, p: PengumumanInput) {
  const peran = p.audience === "all" ? ["customer", "merchant"] : [p.audience];
  return dalamTransaksi(async (conn) => {
    const [r] = await conn.query<ResultSetHeader>(
      `INSERT INTO notifications (user_id, type, title, body, data, created_at)
       SELECT id, 'info', ?, ?, JSON_OBJECT('audience', ?), UTC_TIMESTAMP() FROM users WHERE is_active AND role IN (?)`,
      [p.title, p.body, p.audience, peran],
    );
    await catat(conn, { adminId, action: "notification.broadcast", targetType: "notification", targetId: p.audience, after: { ...p, sent: r.affectedRows } });
    return { sent: r.affectedRows };
  });
}

// Broadcast: promo toko yang aktif dan belum berakhir → notifikasi tipe "promo" ke pembeli yang memfavoritkan menu toko itu.
// shortcut: dikirim setiap kali promo diaktifkan (mati-hidup berulang = notifikasi berulang); beri jeda per promo bila dikeluhkan
export async function kabariPromoToko(p: RowDataPacket) {
  if (!p.is_active || new Date(p.ends_at).getTime() <= Date.now()) return;
  const [[m]] = await db.query<RowDataPacket[]>("SELECT business_name FROM merchants WHERE id = ?", [p.merchant_id]);
  const title = `Promo baru dari ${m.business_name}`.slice(0, 120);
  const body = `Pakai kode ${p.code}${p.description ? `: ${p.description}` : " saat checkout."}`.slice(0, 255);
  await db.query(
    `INSERT INTO notifications (user_id, type, title, body, data, created_at)
     SELECT DISTINCT f.user_id, 'promo', ?, ?, JSON_OBJECT('promo_code', ?, 'merchant_id', ?), UTC_TIMESTAMP()
     FROM favorites f JOIN menus x ON x.id = f.menu_id JOIN users u ON u.id = f.user_id
     WHERE x.merchant_id = ? AND x.deleted_at IS NULL AND u.is_active`,
    [title, body, p.code, p.merchant_id, p.merchant_id],
  );
}
