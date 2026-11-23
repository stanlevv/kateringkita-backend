// Isi file: unggah foto ke penyimpanan Cloudflare R2. Dipakai handler foto profil (auth), foto toko/menu (merchant),
// dan gambar banner/pop-up (banner); pemeriksa URL foto dipakai service yang menyimpan URL foto.
// Server tidak menerima file fotonya. Server hanya membuat presigned upload URL: alamat unggah sementara yang sudah
// ditandatangani server dan berlaku beberapa menit. Aplikasi mengirim fotonya langsung ke R2 lewat alamat itu, lalu
// menyimpan URL publiknya lewat endpoint lain, yang memeriksanya dengan validateImageUrl.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { uploadSchema } from "../dto/upload.dto";
import { AppError } from "../utils/errors";
import { PRESIGN_SECONDS, presignPut, getR2Config } from "../utils/r2";

// Ekstensi nama file untuk tiap tipe gambar yang diterima.
const FILE_EXTENSIONS = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } as const;

/**
 * Membuat alamat unggah sementara untuk satu foto. Nama file (kunci objek) selalu dibuat server: awalan folder milik
 * pengguna + UUID (id acak yang praktis tidak mungkin kembar) + ekstensi. Aplikasi tidak bisa memilih lokasi sendiri.
 * @param prefix awalan folder pemilik, contoh `users/12/avatar/`. Dibentuk handler dari id di token login; untuk foto
 *               toko dan gambar platform ditambah `purpose` dari isi permintaan yang dibatasi daftar nilai (z.enum),
 *               jadi pengguna tidak bisa menulis ke folder sembarang
 * @param input  tipe gambar (`content_type`) dan ukuran dalam byte (`size`) yang sudah lolos uploadSchema; keduanya
 *               ikut ditandatangani, jadi R2 menolak file dengan tipe atau ukuran lain
 * @returns `upload_url` (alamat PUT ke R2), `public_url` (alamat foto setelah terunggah), dan `expires_at` (batas waktu
 *          alamat unggah, format ISO)
 * @throws 503 SERVICE_UNAVAILABLE bila pengaturan R2 belum diisi di server
 */
// shortcut: objek R2 yang diganti/ditinggalkan tidak pernah dihapus, pasang lifecycle rule bucket atau job pembersih bila biaya penyimpanan terasa
export function createUpload(prefix: string, input: z.infer<typeof uploadSchema>) {
  const r2Config = getR2Config();
  if (!r2Config) throw new AppError(503, "SERVICE_UNAVAILABLE", "Unggah foto belum tersedia. Coba lagi nanti.");
  const now = new Date();
  const key = `${prefix}${randomUUID()}.${FILE_EXTENSIONS[input.content_type]}`;
  return {
    upload_url: presignPut(r2Config, { key, contentType: input.content_type, size: input.size, now }),
    public_url: `${r2Config.publicUrl}/${key}`,
    expires_at: new Date(now.getTime() + PRESIGN_SECONDS * 1000).toISOString(),
  };
}

// Nama file yang dibuat createUpload: UUID huruf kecil + ekstensi jpg/png/webp.
const OBJECT_NAME_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/;

/**
 * Memeriksa URL foto yang dikirim aplikasi sebelum disimpan, supaya pengguna hanya bisa memakai foto hasil unggahan
 * ke foldernya sendiri. URL lolos bila kosong (`undefined`/`null`), sama dengan URL yang sudah tersimpan, atau persis
 * berbentuk `<R2_PUBLIC_URL>/<prefix><uuid>.<ext>`. Bila R2 belum diatur, semua URL baru ditolak.
 * @param url      URL foto yang dikirim aplikasi
 * @param savedUrl URL foto yang sekarang tersimpan di database (`null` bila belum ada)
 * @param prefix   awalan folder yang diizinkan, contoh `merchants/5/logo/`
 * @param field    nama kolom untuk pesan galat, contoh `logo_url`
 * @throws 400 VALIDATION_ERROR di kolom `field` bila URL tidak memenuhi aturan di atas
 */
// shortcut: keberadaan objek di R2 tidak dicek (butuh jaringan), cek HEAD bila foto rusak jadi masalah nyata
export function validateImageUrl(
  url: string | null | undefined,
  savedUrl: string | null,
  prefix: string,
  field: string,
): void {
  if (url === undefined || url === null || url === savedUrl) return;
  const r2Config = getR2Config();
  const allowedBaseUrl = r2Config ? `${r2Config.publicUrl}/${prefix}` : null;
  if (allowedBaseUrl && url.startsWith(allowedBaseUrl) && OBJECT_NAME_PATTERN.test(url.slice(allowedBaseUrl.length)))
    return;
  throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", {
    [field]: ["Foto tidak valid. Unggah ulang foto."],
  });
}
