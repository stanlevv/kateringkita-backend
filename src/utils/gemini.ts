import { env } from "../config/env";
import { AppError } from "./errors";

// F17: Gemini REST generateContent lewat fetch bawaan (tanpa SDK). Objek agar test bisa memata-matai `tanya`.
const URL_API = "https://generativelanguage.googleapis.com/v1beta/models";

export const gemini = {
  async tanya(system: string, pesan: string): Promise<string> {
    if (!env.GEMINI_API_KEY) throw new AppError(503, "SERVICE_UNAVAILABLE", "Asisten AI belum diaktifkan.");
    const gagal = () => new AppError(502, "UPSTREAM_ERROR", "Asisten AI sedang tidak bisa dihubungi. Coba lagi sebentar lagi.");
    let res: Response;
    try {
      res = await fetch(`${URL_API}/${encodeURIComponent(env.GEMINI_MODEL)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: pesan }] }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 1024 },
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw gagal();
    }
    if (!res.ok) throw gagal();
    const body = (await res.json().catch(() => null)) as { candidates?: { content?: { parts?: { text?: string }[] } }[] } | null;
    const teks = body?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("").trim();
    if (!teks) throw gagal();
    return teks;
  },
};
