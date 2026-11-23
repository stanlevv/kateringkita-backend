import { z } from "zod";

// F17: satu pertanyaan penjual
const QUESTION_MSG = "Pertanyaan 1–500 karakter.";
export const askAssistantSchema = z.object({
  question: z.string({ error: QUESTION_MSG }).trim().min(1, QUESTION_MSG).max(500, QUESTION_MSG),
});
