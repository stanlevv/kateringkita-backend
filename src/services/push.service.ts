// Isi file: pengiriman push FCM (Firebase Cloud Messaging) ke perangkat pembeli yang sesinya masih aktif (F40).
// Token diambil dari tabel `push_tokens`; token yang ditolak FCM dihapus. Kegagalan push tidak pernah dilempar ke
// pemanggil supaya tidak mengubah respons HTTP atau membatalkan transaksi.
import { cert, initializeApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import db from "../config/db";
import { env } from "../config/env";

/** Isi satu push. Nilai `data` harus string (syarat FCM). */
export type PushMessage = {
  title: string;
  body: string;
  data: { type: "order_status" | "chat_message"; order_code: string };
};

/** Pengirim push ke banyak token; mengembalikan token yang sudah tidak berlaku. */
export type PushTransport = (tokens: string[], message: PushMessage) => Promise<{ invalidTokens: string[] }>;

const INVALID_TOKEN_CODES = ["messaging/registration-token-not-registered", "messaging/invalid-registration-token"];

/**
 * Membuat pengirim FCM dari kunci service account.
 * @param serviceAccount JSON mentah atau JSON yang di-base64
 */
export function firebaseTransport(serviceAccount: string): PushTransport {
  let json: string;
  try {
    JSON.parse(serviceAccount);
    json = serviceAccount;
  } catch {
    json = Buffer.from(serviceAccount, "base64").toString("utf8");
  }
  const app = initializeApp({ credential: cert(JSON.parse(json)) });
  return async (tokens, { title, body, data }) => {
    const result = await getMessaging(app).sendEachForMulticast({ tokens, notification: { title, body }, data });
    const invalidTokens = tokens.filter((_, i) => INVALID_TOKEN_CODES.includes(result.responses[i]?.error?.code ?? ""));
    return { invalidTokens };
  };
}

// undefined = belum dipilih; dibuat saat dipakai pertama kali supaya mengimpor file ini (mis. di test) tidak
// menyentuh Firebase.
let transport: PushTransport | null | undefined;

if (!env.FIREBASE_SERVICE_ACCOUNT && env.NODE_ENV === "production") {
  console.warn("FIREBASE_SERVICE_ACCOUNT kosong: push notifikasi mati");
}

function getTransport(): PushTransport | null {
  if (transport === undefined) {
    transport = null;
    if (env.FIREBASE_SERVICE_ACCOUNT) {
      try {
        transport = firebaseTransport(env.FIREBASE_SERVICE_ACCOUNT);
      } catch (error) {
        console.error("FIREBASE_SERVICE_ACCOUNT tidak valid, push mati:", error);
      }
    }
  }
  return transport;
}

/**
 * Mengganti pengirim push. Hanya untuk test; `null` mematikan push.
 * @param newTransport pengirim pengganti
 */
export function setPushTransport(newTransport: PushTransport | null): void {
  transport = newTransport;
}

/**
 * Mengirim push ke semua perangkat milik pembeli yang sesi loginnya aktif. Tidak pernah melempar.
 * @param userId  id pembeli penerima
 * @param message isi push
 */
export async function sendPushToUser(userId: number, message: PushMessage): Promise<void> {
  try {
    const send = getTransport();
    if (!send) return;
    const [rows] = await db.query<any[]>(
      `SELECT t.token FROM push_tokens t JOIN auth_sessions s ON s.jti = t.session_jti
       WHERE t.user_id = ? AND s.revoked_at IS NULL AND s.expires_at > UTC_TIMESTAMP()`,
      [userId],
    );
    const tokens = (rows as { token: string }[]).map((row) => row.token);
    if (tokens.length === 0) return;
    const { invalidTokens } = await send(tokens, message);
    if (invalidTokens.length > 0) await db.query("DELETE FROM push_tokens WHERE token IN (?)", [invalidTokens]);
  } catch (error) {
    console.error("Gagal mengirim push:", error);
  }
}
