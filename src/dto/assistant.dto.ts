// Isi file: skema zod untuk isi `POST /merchant/assistant` (pertanyaan penjual ke asisten AI). zod = pustaka yang
// memeriksa bentuk data masuk; data yang tidak lolos dijawab 400 beserta pesan per kolom. Dipakai routes/merchant.ts
// sebelum handler memanggil assistant.service. Nama kunci di sini adalah kontrak JSON.
import { z } from "zod";

const QUESTION_MSG = "Pertanyaan 1–500 karakter.";
/** Isi permintaan asisten AI: satu `question` berisi 1–500 karakter setelah spasi di ujung dibuang. */
export const askAssistantSchema = z.object({
  question: z.string({ error: QUESTION_MSG }).trim().min(1, QUESTION_MSG).max(500, QUESTION_MSG),
});
