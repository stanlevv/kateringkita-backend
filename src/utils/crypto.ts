// Isi file: mengenkripsi rahasia yang harus disimpan di database, yaitu API key penyedia AI yang diisi admin.
// Dipakai ai.service. Enkripsi memakai AES-256-GCM: teks diacak dengan sebuah kunci, dan hanya kunci yang sama yang bisa
// membukanya; GCM juga menambah "tag" sehingga isi yang diubah orang lain ketahuan saat dibuka.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "../config/env";

// Kunci enkripsi diturunkan dari JWT_SECRET plus label khusus, jadi tidak perlu variabel env baru.
// Akibatnya: bila JWT_SECRET diganti, semua API key AI tidak bisa dibuka lagi dan harus diisi ulang oleh admin.
const getEncryptionKey = () => createHash("sha256").update(`kateringkita:ai-key:${env.JWT_SECRET}`).digest();

/**
 * Mengenkripsi teks dengan AES-256-GCM.
 * @param plainText teks asli, contoh API key
 * @returns teks terenkripsi berbentuk `"iv.tag.data"` (tiga bagian base64url): `iv` angka acak pembuka yang berbeda di
 *          setiap enkripsi, `tag` penanda keaslian, `data` isi yang diacak
 */
export function encrypt(plainText: string): string {
  const initVector = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getEncryptionKey(), initVector);
  const data = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  return [initVector, cipher.getAuthTag(), data].map((buffer) => buffer.toString("base64url")).join(".");
}

/**
 * Membuka teks hasil {@link encrypt}.
 * @param encryptedText teks berbentuk `"iv.tag.data"`
 * @returns teks asli, atau `null` bila isinya rusak atau kuncinya sudah berubah (tag tidak cocok)
 */
export function decrypt(encryptedText: string): string | null {
  try {
    const [initVector, authTag, data] = encryptedText.split(".").map((part) => Buffer.from(part, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", getEncryptionKey(), initVector);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
