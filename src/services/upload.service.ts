import { randomUUID } from "node:crypto";
import { z } from "zod";
import { uploadSchema } from "../dto/upload.dto";
import { AppError } from "../utils/errors";
import { PRESIGN_DETIK, presignPut, r2Config } from "../utils/r2";

const EKSTENSI = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } as const;

// Kunci objek selalu dibuat server di bawah awalan pemilik (D12)
// shortcut: objek R2 yang diganti/ditinggalkan tidak pernah dihapus, pasang lifecycle rule bucket atau job pembersih bila biaya penyimpanan terasa
export function buatUnggahan(prefix: string, input: z.infer<typeof uploadSchema>) {
  const cfg = r2Config();
  if (!cfg) throw new AppError(503, "SERVICE_UNAVAILABLE", "Unggah foto belum tersedia. Coba lagi nanti.");
  const now = new Date();
  const key = `${prefix}${randomUUID()}.${EKSTENSI[input.content_type]}`;
  return {
    upload_url: presignPut(cfg, { key, contentType: input.content_type, size: input.size, now }),
    public_url: `${cfg.publicUrl}/${key}`,
    expires_at: new Date(now.getTime() + PRESIGN_DETIK * 1000).toISOString(),
  };
}

const NAMA_OBJEK = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/;

// D10: null, sama dengan tersimpan, atau tepat <R2_PUBLIC_URL>/<prefix><uuid>.<ext>; selain itu 400 di `field`.
// shortcut: keberadaan objek di R2 tidak dicek (butuh jaringan), cek HEAD bila foto rusak jadi masalah nyata
export function cekUrlGambar(url: string | null | undefined, tersimpan: string | null, prefix: string, field: string): void {
  if (url === undefined || url === null || url === tersimpan) return;
  const cfg = r2Config();
  const dasar = cfg ? `${cfg.publicUrl}/${prefix}` : null;
  if (dasar && url.startsWith(dasar) && NAMA_OBJEK.test(url.slice(dasar.length))) return;
  throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", { [field]: ["Foto tidak valid. Unggah ulang foto."] });
}
