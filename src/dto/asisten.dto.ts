import { z } from "zod";

// F17: satu pertanyaan penjual
const TANYA = "Pertanyaan 1–500 karakter.";
export const tanyaSchema = z.object({ question: z.string({ error: TANYA }).trim().min(1, TANYA).max(500, TANYA) });
