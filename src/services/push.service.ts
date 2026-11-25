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
 * Kode galat berbeda dari token yang gagal dikirim bukan karena token mati (mis. kuota, kredensial salah). Hanya kode,
 * tidak pernah token atau objek galatnya.
 * @param responses hasil per token dari `sendEachForMulticast`
 */
export function otherFailureCodes(responses: { error?: { code?: string } }[]): string[] {
  const codes = responses.flatMap((response) => (response.error ? [response.error.code ?? "unknown"] : []));
  return [...new Set(codes.filter((code) => !INVALID_TOKEN_CODES.includes(code)))];
}

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
    const otherCodes = otherFailureCodes(result.responses);
    if (otherCodes.length > 0) console.error("Sebagian push gagal terkirim, kode galat:", otherCodes.join(", "));
    return { invalidTokens };
  };
}

// undefined = belum dipilih; dibuat saat dipakai pertama kali supaya mengimpor file ini (mis. di test) tidak
// menyentuh Firebase.
let transport: PushTransport | null | undefined;

if (!env.FIREBASE_SERVICE_ACCOUNT && env.NODE_ENV === "production") {
  console.warn("FIREBASE_SERVICE_ACCOUNT kosong: push notifikasi mati");
}

/**
 * Membuat pengirim bawaan dari kunci service account; `null` bila kosong atau tidak valid. Galatnya sengaja tidak
 * dicatat utuh: pesan galat JSON.parse mengutip potongan isi kunci.
 * @param serviceAccount isi FIREBASE_SERVICE_ACCOUNT
 */
export function createDefaultTransport(serviceAccount: string | undefined): PushTransport | null {
  if (!serviceAccount) return null;
  try {
    return firebaseTransport(serviceAccount);
  } catch (error) {
    console.error("FIREBASE_SERVICE_ACCOUNT tidak valid, push mati:", error instanceof Error ? error.name : "galat");
    return null;
  }
}

function getTransport(): PushTransport | null {
  if (transport === undefined) transport = createDefaultTransport(env.FIREBASE_SERVICE_ACCOUNT);
  return transport;
}

/**
 * Membuat pengirim saat server mulai (hanya production, bila kunci diisi) supaya kunci yang rusak terlihat di log boot.
 * Tidak pernah melempar.
 */
export function warmUpPushTransport(): void {
  if (env.NODE_ENV === "production" && env.FIREBASE_SERVICE_ACCOUNT) getTransport();
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
    // hanya pesan: objek galat mysql2 membawa SQL berisi token perangkat
    console.error("Gagal mengirim push:", error instanceof Error ? error.message : String(error));
  }
}
