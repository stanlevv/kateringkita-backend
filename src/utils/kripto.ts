import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "../config/env";

// F22: enkripsi rahasia di DB (API key penyedia AI). AES-256-GCM; kunci diturunkan dari JWT_SECRET dengan label sendiri,
// jadi tidak perlu variabel env baru. Ganti JWT_SECRET = semua key AI harus diisi ulang admin.
const kunci = () => createHash("sha256").update(`kateringkita:ai-key:${env.JWT_SECRET}`).digest();

/** "iv.tag.data" dalam base64url */
export function enkripsi(teks: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", kunci(), iv);
  const data = Buffer.concat([c.update(teks, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
}

/** null bila rusak atau kunci berubah (tag GCM tidak cocok) */
export function dekripsi(isi: string): string | null {
  try {
    const [iv, tag, data] = isi.split(".").map((s) => Buffer.from(s, "base64url"));
    const d = createDecipheriv("aes-256-gcm", kunci(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}
