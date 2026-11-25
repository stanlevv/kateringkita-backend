// Isi file: penyimpanan token FCM perangkat pembeli di tabel `push_tokens` (F40). Alurnya routes/notification.ts →
// handlers/notification.handler.ts → file ini → database. Token terikat ke sesi login (jti) supaya logout bisa
// menghapusnya.
import db from "../config/db";
import type { PushTokenInput } from "../dto/push-token.dto";

/**
 * Menyimpan token perangkat untuk sesi login ini. Token yang sudah ada (milik akun atau sesi lain) dipindahkan ke
 * akun dan sesi ini, jadi memanggil dua kali tetap satu baris. Satu sesi paling banyak memegang satu token: token
 * lama sesi ini dihapus.
 * @param userId id pembeli yang login
 * @param jti    id sesi login saat ini
 * @param input  token FCM dan platform perangkat
 */
export async function registerPushToken(userId: number, jti: string, input: PushTokenInput): Promise<void> {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("DELETE FROM push_tokens WHERE session_jti = ? AND token <> ?", [jti, input.token]);
    await conn.query(
      `INSERT INTO push_tokens (user_id, session_jti, token, platform) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), session_jti = VALUES(session_jti), platform = VALUES(platform)`,
      [userId, jti, input.token, input.platform],
    );
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

/**
 * Menghapus semua token milik sesi login ini (dipanggil saat logout di perangkat). Sesi lain tidak terpengaruh.
 * @param jti id sesi login saat ini
 */
export async function unregisterPushToken(jti: string): Promise<void> {
  await db.query("DELETE FROM push_tokens WHERE session_jti = ?", [jti]);
}
