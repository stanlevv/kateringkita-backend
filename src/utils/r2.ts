import { createHash, createHmac } from "node:crypto";
import { env } from "../config/env";

export type R2Config = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicUrl: string;
};

// Dibaca saat dipanggil (bukan saat modul dimuat); env.ts menjamin terisi semua atau kosong semua (D13)
export function getR2Config(): R2Config | null {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_URL } = env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET || !R2_PUBLIC_URL) return null;
  return {
    accountId: R2_ACCOUNT_ID,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    bucket: R2_BUCKET,
    publicUrl: R2_PUBLIC_URL,
  };
}

// RFC 3986: encodeURIComponent juga meng-encode !'()* seperti yang diminta SigV4
const encodeRfc3986 = (text: string) =>
  encodeURIComponent(text).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
const hmacSha256 = (key: string | Buffer, text: string) => createHmac("sha256", key).update(text).digest();

// AWS SigV4 query-string presign (D11), UNSIGNED-PAYLOAD; host selalu ikut ditandatangani
export function presignSigV4Url(request: {
  method: string;
  host: string;
  path: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  now: Date;
  expires: number;
  headers: Record<string, string>;
}): string {
  const amzDate = request.now.toISOString().replace(/[-:]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${request.region}/${request.service}/aws4_request`;
  const headers: Record<string, string> = { host: request.host };
  for (const [headerName, headerValue] of Object.entries(request.headers))
    headers[headerName.toLowerCase()] = headerValue.trim();
  const headerNames = Object.keys(headers).sort();
  const signedHeaders = headerNames.join(";");
  const params: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${request.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(request.expires),
    "X-Amz-SignedHeaders": signedHeaders,
  };
  const query = Object.keys(params)
    .sort()
    .map((paramName) => `${encodeRfc3986(paramName)}=${encodeRfc3986(params[paramName])}`)
    .join("&");
  const path = request.path.split("/").map(encodeRfc3986).join("/");
  const canonicalRequest = [
    request.method,
    path,
    query,
    headerNames.map((n) => `${n}:${headers[n]}\n`).join(""),
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");
  const signingKey = [request.region, request.service, "aws4_request"].reduce<Buffer>(
    (previousKey, part) => hmacSha256(previousKey, part),
    hmacSha256(`AWS4${request.secretAccessKey}`, day),
  );
  return `https://${request.host}${path}?${query}&X-Amz-Signature=${createHmac("sha256", signingKey).update(stringToSign).digest("hex")}`;
}

export const PRESIGN_SECONDS = 300;

// URL PUT R2 path-style; ukuran & tipe ditandatangani sehingga R2 menolak berkas yang berbeda (D11)
export const presignPut = (
  config: R2Config,
  file: { key: string; contentType: string; size: number; now?: Date },
): string =>
  presignSigV4Url({
    method: "PUT",
    host: `${config.accountId}.r2.cloudflarestorage.com`,
    path: `/${config.bucket}/${file.key}`,
    region: "auto",
    service: "s3",
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    now: file.now ?? new Date(),
    expires: PRESIGN_SECONDS,
    headers: { "content-length": String(file.size), "content-type": file.contentType },
  });
