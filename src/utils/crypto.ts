import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "../config/env";

// F22: enkripsi rahasia di DB (API key penyedia AI). AES-256-GCM; kunci diturunkan dari JWT_SECRET dengan label sendiri,
// jadi tidak perlu variabel env baru. Ganti JWT_SECRET = semua key AI harus diisi ulang admin.
const getEncryptionKey = () => createHash("sha256").update(`kateringkita:ai-key:${env.JWT_SECRET}`).digest();

/** "iv.tag.data" dalam base64url */
export function encrypt(plainText: string): string {
  const initVector = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getEncryptionKey(), initVector);
  const data = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  return [initVector, cipher.getAuthTag(), data].map((buffer) => buffer.toString("base64url")).join(".");
}

/** null bila rusak atau kunci berubah (tag GCM tidak cocok) */
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
