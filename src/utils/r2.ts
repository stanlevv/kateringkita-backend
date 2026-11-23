// Isi file: pembuat presigned URL untuk Cloudflare R2 (penyimpanan file foto). Presigned URL = alamat unggah sekali
// pakai yang sudah ditandatangani server dengan kunci rahasia R2, sehingga aplikasi bisa mengunggah foto langsung ke R2
// tanpa pernah memegang kunci rahasianya. Dipakai upload.service. Tanda tangannya memakai cara AWS "Signature Version 4"
// (SigV4), yang juga dipahami R2.
import { createHash, createHmac } from "node:crypto";
import { env } from "../config/env";

/** Pengaturan akun R2 yang dibutuhkan untuk membuat presigned URL. */
export type R2Config = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicUrl: string;
};

/**
 * Mengambil pengaturan R2 dari env. Dibaca setiap kali dipanggil (bukan saat file dimuat) supaya test bisa
 * mengubahnya. env.ts menjamin variabel R2 terisi semua atau kosong semua.
 * @returns pengaturan R2, atau `null` bila R2 belum diatur (unggah foto mati)
 */
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

// Encode URL menurut aturan RFC 3986 yang diminta SigV4: encodeURIComponent bawaan tidak meng-encode !'()*, jadi
// karakter itu di-encode sendiri.
const encodeRfc3986 = (text: string) =>
  encodeURIComponent(text).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
// HMAC-SHA256 = sidik jari teks yang hanya bisa dibuat oleh pemegang kunci.
const hmacSha256 = (key: string | Buffer, text: string) => createHmac("sha256", key).update(text).digest();

/**
 * Membuat presigned URL bertanda tangan SigV4 (tanda tangan ditaruh di query string URL). Isi file tidak ikut
 * ditandatangani (`UNSIGNED-PAYLOAD`), tetapi header `host` selalu ikut ditandatangani, begitu juga header lain di
 * `request.headers`; penyimpanan menolak unggahan yang header-nya berbeda.
 * @param request method, host, path, region, service, kunci akses, waktu sekarang, masa berlaku (detik), dan header
 *                yang ikut ditandatangani
 * @returns URL lengkap `https://…` beserta tanda tangannya
 */
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
  // 1. Waktu dan "scope" (tanggal/region/layanan) yang ikut ditandatangani.
  const amzDate = request.now.toISOString().replace(/[-:]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${request.region}/${request.service}/aws4_request`;
  // 2. Header yang ditandatangani: nama huruf kecil, nilai tanpa spasi tepi, diurutkan menurut nama.
  const headers: Record<string, string> = { host: request.host };
  for (const [headerName, headerValue] of Object.entries(request.headers))
    headers[headerName.toLowerCase()] = headerValue.trim();
  const headerNames = Object.keys(headers).sort();
  const signedHeaders = headerNames.join(";");
  // 3. Parameter query SigV4, diurutkan dan di-encode.
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
  // 4. Susun "canonical request" (permintaan dalam bentuk baku) dan teks yang akan ditandatangani.
  const path = request.path.split("/").map(encodeRfc3986).join("/");
  const canonicalRequest = [
    request.method,
    path,
    query,
    headerNames.map((headerName) => `${headerName}:${headers[headerName]}\n`).join(""),
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");
  // 5. Turunkan kunci tanda tangan dari kunci rahasia secara bertingkat (tanggal → region → layanan), lalu tandatangani.
  const signingKey = [request.region, request.service, "aws4_request"].reduce<Buffer>(
    (previousKey, part) => hmacSha256(previousKey, part),
    hmacSha256(`AWS4${request.secretAccessKey}`, day),
  );
  return `https://${request.host}${path}?${query}&X-Amz-Signature=${createHmac("sha256", signingKey).update(stringToSign).digest("hex")}`;
}

/** Masa berlaku presigned URL unggah, dalam detik (5 menit). */
export const PRESIGN_SECONDS = 300;

/**
 * Membuat presigned URL `PUT` untuk mengunggah satu file ke bucket R2 (alamat bergaya path: `/<bucket>/<key>`).
 * Ukuran dan tipe file ikut ditandatangani, sehingga R2 menolak file yang ukuran atau tipenya berbeda dari yang diminta.
 * @param config pengaturan R2 dari {@link getR2Config}
 * @param file   `key` lokasi file di bucket, `contentType` tipe file (contoh `image/webp`), `size` ukuran dalam byte,
 *               `now` waktu sekarang (boleh kosong; diisi test supaya hasilnya tetap)
 * @returns presigned URL yang berlaku {@link PRESIGN_SECONDS} detik
 */
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
