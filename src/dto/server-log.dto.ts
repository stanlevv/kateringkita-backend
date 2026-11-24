// Isi file: skema zod untuk query daftar log server di dasbor server admin super (GET /admin/server-logs). Dipakai
// handlers/server-log.handler.ts; query yang tidak lolos dijawab 400 beserta pesan per kolom.
import { z } from "zod";

/**
 * Query daftar log server: `level` `error`/`slow` opsional, `q` kata kunci paling banyak 128 karakter (kosong = tanpa
 * pencarian), `page` mulai 1 (bawaan 1), `limit` 1–50 (bawaan 20).
 */
export const serverLogFilterSchema = z.object({
  level: z.enum(["error", "slow"], { error: "Level tidak dikenal." }).optional(),
  q: z
    .string()
    .trim()
    .max(128, "Pencarian maksimal 128 karakter.")
    .optional()
    .transform((text) => text || undefined),
  page: z.coerce
    .number({ error: "Halaman tidak valid." })
    .int("Halaman tidak valid.")
    .min(1, "Halaman tidak valid.")
    .default(1),
  limit: z.coerce
    .number({ error: "Batas tidak valid." })
    .int("Batas tidak valid.")
    .min(1, "Batas 1–50.")
    .max(50, "Batas 1–50.")
    .default(20),
});
