import { randomUUID } from "node:crypto";
import { z } from "zod";
import { uploadSchema } from "../dto/upload.dto";
import { AppError } from "../utils/errors";
import { PRESIGN_SECONDS, presignPut, getR2Config } from "../utils/r2";

const FILE_EXTENSIONS = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } as const;

// Kunci objek selalu dibuat server di bawah awalan pemilik (D12)
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

const OBJECT_NAME_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/;

// D10: null, sama dengan tersimpan, atau tepat <R2_PUBLIC_URL>/<prefix><uuid>.<ext>; selain itu 400 di `field`.
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
