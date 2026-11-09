import { z } from "zod";

// F23 filter log server (query string)
export const filterLogServerSchema = z.object({
  level: z.enum(["error", "slow"], { error: "Level tidak dikenal." }).optional(),
  q: z.string().trim().max(128, "Pencarian maksimal 128 karakter.").optional().transform((s) => s || undefined),
  page: z.coerce.number({ error: "Halaman tidak valid." }).int("Halaman tidak valid.").min(1, "Halaman tidak valid.").default(1),
  limit: z.coerce.number({ error: "Batas tidak valid." }).int("Batas tidak valid.").min(1, "Batas 1–50.").max(50, "Batas 1–50.").default(20),
});
