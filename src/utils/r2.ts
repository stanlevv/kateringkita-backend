import { createHash, createHmac } from "node:crypto";
import { env } from "../config/env";

export type R2Config = { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string; publicUrl: string };

// Dibaca saat dipanggil (bukan saat modul dimuat); env.ts menjamin terisi semua atau kosong semua (D13)
export function r2Config(): R2Config | null {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_URL } = env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET || !R2_PUBLIC_URL) return null;
  return { accountId: R2_ACCOUNT_ID, accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY, bucket: R2_BUCKET, publicUrl: R2_PUBLIC_URL };
}

// RFC 3986: encodeURIComponent juga meng-encode !'()* seperti yang diminta SigV4
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const hmac = (k: string | Buffer, s: string) => createHmac("sha256", k).update(s).digest();

// AWS SigV4 query-string presign (D11), UNSIGNED-PAYLOAD; host selalu ikut ditandatangani
export function sigv4Query(o: {
  method: string; host: string; path: string; region: string; service: string;
  accessKeyId: string; secretAccessKey: string; now: Date; expires: number; headers: Record<string, string>;
}): string {
  const amzDate = o.now.toISOString().replace(/[-:]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${o.region}/${o.service}/aws4_request`;
  const headers: Record<string, string> = { host: o.host };
  for (const [k, v] of Object.entries(o.headers)) headers[k.toLowerCase()] = v.trim();
  const names = Object.keys(headers).sort();
  const signed = names.join(";");
  const params: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${o.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(o.expires),
    "X-Amz-SignedHeaders": signed,
  };
  const query = Object.keys(params).sort().map((k) => `${enc(k)}=${enc(params[k])}`).join("&");
  const path = o.path.split("/").map(enc).join("/");
  const canonical = [o.method, path, query, names.map((n) => `${n}:${headers[n]}\n`).join(""), signed, "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, createHash("sha256").update(canonical).digest("hex")].join("\n");
  const key = [o.region, o.service, "aws4_request"].reduce<Buffer>((k, s) => hmac(k, s), hmac(`AWS4${o.secretAccessKey}`, day));
  return `https://${o.host}${path}?${query}&X-Amz-Signature=${createHmac("sha256", key).update(toSign).digest("hex")}`;
}

export const PRESIGN_DETIK = 300;

// URL PUT R2 path-style; ukuran & tipe ditandatangani sehingga R2 menolak berkas yang berbeda (D11)
export const presignPut = (cfg: R2Config, f: { key: string; contentType: string; size: number; now?: Date }): string =>
  sigv4Query({
    method: "PUT", host: `${cfg.accountId}.r2.cloudflarestorage.com`, path: `/${cfg.bucket}/${f.key}`, region: "auto", service: "s3",
    accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, now: f.now ?? new Date(), expires: PRESIGN_DETIK,
    headers: { "content-length": String(f.size), "content-type": f.contentType },
  });
