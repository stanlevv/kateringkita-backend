import { z } from "zod";

export const reasonBody = z.object({
  reason: z.string({ error: "Alasan wajib diisi." }).trim().min(1, "Alasan wajib diisi.").max(500, "Alasan maksimal 500 karakter."),
});
