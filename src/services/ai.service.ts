import { ResultSetHeader, RowDataPacket } from "mysql2";
import db from "../config/db";
import { env } from "../config/env";
import { AppError } from "../utils/errors";
import { dekripsi, enkripsi } from "../utils/kripto";
import type { AiInput, UbahAiInput } from "../dto/ai.dto";
import { catat, dalamTransaksi, type Conn } from "./admin-audit.service";

// F22 AI gateway: penyedia dari DB (dikelola admin) dicoba urut prioritas; gagal (kuota/error/timeout) → istirahat sebentar
// → penyedia berikutnya. GEMINI_API_KEY di env = cadangan terakhir (perilaku F17 lama tetap jalan tanpa isian admin).
export const JENIS = {
  gemini: { nama: "Google Gemini (AI Studio)", url: "https://generativelanguage.googleapis.com/v1beta/models" },
  groq: { nama: "Groq", url: "https://api.groq.com/openai/v1/chat/completions" },
  openrouter: { nama: "OpenRouter", url: "https://openrouter.ai/api/v1/chat/completions" },
  nvidia: { nama: "NVIDIA NIM", url: "https://integrate.api.nvidia.com/v1/chat/completions" },
} as const;
export type Jenis = keyof typeof JENIS;
type Penyedia = { id: number | null; jenis: Jenis; label: string; model: string; key: string };

class GagalPenyedia extends Error {
  constructor(message: string, readonly istirahatDetik: number) {
    super(message);
  }
}

// Kode jawaban → pesan untuk admin + lama istirahat. 429 memakai Retry-After bila ada (maks 1 jam).
async function kirim(url: string, init: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new GagalPenyedia("Tidak menjawab (timeout/jaringan).", 30);
  }
  if (!res.ok) {
    if (res.status === 429) {
      const s = Number(res.headers.get("retry-after"));
      throw new GagalPenyedia("Kuota/batas pemakaian habis (429).", Math.min(s > 0 ? s : 60, 3600));
    }
    if (res.status === 401 || res.status === 403) throw new GagalPenyedia(`API key ditolak (${res.status}).`, 600);
    if (res.status === 400 || res.status === 404) throw new GagalPenyedia(`Permintaan ditolak (${res.status}). Periksa nama model.`, 600);
    throw new GagalPenyedia(`Server penyedia error (${res.status}).`, 30);
  }
  return res.json().catch(() => {
    throw new GagalPenyedia("Jawaban penyedia tidak terbaca.", 30);
  });
}

// Gemini: REST generateContent (sama dengan F17); lainnya format OpenAI chat completions
async function panggil(p: Penyedia, system: string, pesan: string): Promise<string> {
  let teks: string | undefined;
  if (p.jenis === "gemini") {
    const body = await kirim(`${JENIS.gemini.url}/${encodeURIComponent(p.model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": p.key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: pesan }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 1024 },
      }),
    });
    teks = body?.candidates?.[0]?.content?.parts?.map((x: { text?: string }) => x.text ?? "").join("").trim();
  } else {
    const body = await kirim(JENIS[p.jenis].url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.key}`, ...(p.jenis === "openrouter" ? { "X-Title": "KateringKita" } : {}) },
      body: JSON.stringify({
        model: p.model, temperature: 0.4, max_tokens: 1024,
        messages: [{ role: "system", content: system }, { role: "user", content: pesan }],
      }),
    });
    teks = body?.choices?.[0]?.message?.content?.trim();
  }
  if (!teks) throw new GagalPenyedia("Jawaban penyedia kosong.", 30);
  return teks;
}

// istirahat penyedia env disimpan di memori proses (tidak ada barisnya di DB)
let istirahatEnv = 0;

async function tandaiOk(p: Penyedia) {
  if (p.id === null) istirahatEnv = 0;
  else await db.query("UPDATE ai_providers SET last_ok_at = UTC_TIMESTAMP(), cooldown_until = NULL, updated_at = updated_at WHERE id = ?", [p.id]);
}

async function tandaiGagal(p: Pick<Penyedia, "id" | "label">, pesan: string, detik: number) {
  console.error(`AI ${p.label}: ${pesan} → istirahat ${detik} dtk`);
  if (p.id === null) istirahatEnv = Date.now() + detik * 1000;
  else {
    await db.query(
      `UPDATE ai_providers SET last_error = ?, last_error_at = UTC_TIMESTAMP(), cooldown_until = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND),
         updated_at = updated_at WHERE id = ?`,
      [pesan.slice(0, 255), detik, p.id],
    );
  }
}

async function penyedia(): Promise<{ siap: Penyedia[]; ada: boolean }> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, provider, label, model, api_key_enc, cooldown_until > UTC_TIMESTAMP() AS istirahat
     FROM ai_providers WHERE is_active ORDER BY priority, id`,
  );
  const siap: Penyedia[] = [];
  for (const r of rows) {
    if (Number(r.istirahat)) continue;
    const key = dekripsi(r.api_key_enc);
    if (key) siap.push({ id: r.id, jenis: r.provider, label: r.label, model: r.model, key });
    else await tandaiGagal({ id: r.id, label: r.label }, "API key tidak bisa dibuka (JWT_SECRET berubah?). Isi ulang key.", 3600);
  }
  if (env.GEMINI_API_KEY && Date.now() >= istirahatEnv) {
    siap.push({ id: null, jenis: "gemini", label: "GEMINI_API_KEY (env)", model: env.GEMINI_MODEL, key: env.GEMINI_API_KEY });
  }
  return { siap, ada: rows.length > 0 || !!env.GEMINI_API_KEY };
}

/** Satu pintu AI untuk semua fitur (asisten penjual F17, dan rekomendasi pembeli nanti). Objek agar test bisa memata-matai. */
export const ai = {
  async tanya(system: string, pesan: string): Promise<string> {
    const { siap, ada } = await penyedia();
    if (!ada) throw new AppError(503, "SERVICE_UNAVAILABLE", "Asisten AI belum diaktifkan.");
    for (const p of siap) {
      try {
        const teks = await panggil(p, system, pesan);
        await tandaiOk(p);
        return teks;
      } catch (e) {
        if (!(e instanceof GagalPenyedia)) throw e;
        await tandaiGagal(p, e.message, e.istirahatDetik);
      }
    }
    throw new AppError(502, "UPSTREAM_ERROR", "Asisten AI sedang tidak bisa dihubungi. Coba lagi sebentar lagi.");
  },
};

// ---------- admin ----------
const KOLOM = "id, provider, label, model, key_hint, priority, is_active, last_ok_at, last_error, last_error_at, cooldown_until";
// API key tidak pernah keluar: hanya 4 karakter terakhir
const peta = (r: RowDataPacket) => ({
  id: r.id, provider: r.provider as Jenis, provider_name: JENIS[r.provider as Jenis].nama, label: r.label, model: r.model, key_hint: r.key_hint,
  priority: r.priority, is_active: Boolean(r.is_active), last_ok_at: r.last_ok_at, last_error: r.last_error, last_error_at: r.last_error_at,
  cooldown_until: r.cooldown_until,
});
const tidakAda = () => new AppError(404, "NOT_FOUND", "Penyedia AI tidak ditemukan.");
const idSah = (raw: unknown) => {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) throw tidakAda();
  return id;
};
async function ambil(conn: Pick<Conn, "query">, id: number, kunciBaris = false) {
  const [[r]] = await conn.query<RowDataPacket[]>(`SELECT ${KOLOM} FROM ai_providers WHERE id = ?${kunciBaris ? " FOR UPDATE" : ""}`, [id]);
  if (!r) throw tidakAda();
  return peta(r);
}

export async function daftarAi() {
  const [rows] = await db.query<RowDataPacket[]>(`SELECT ${KOLOM} FROM ai_providers ORDER BY priority, id`);
  return { providers: rows.map(peta), env_gemini: env.GEMINI_API_KEY ? { model: env.GEMINI_MODEL } : null };
}

export const buatAi = (adminId: number, input: AiInput) => dalamTransaksi(async (conn) => {
  const [r] = await conn.query<ResultSetHeader>(
    "INSERT INTO ai_providers (provider, label, model, api_key_enc, key_hint, priority, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [input.provider, input.label, input.model, enkripsi(input.api_key), input.api_key.slice(-4), input.priority, input.is_active],
  );
  const baru = await ambil(conn, r.insertId);
  await catat(conn, { adminId, action: "ai.create", targetType: "ai_provider", targetId: r.insertId, after: baru });
  return baru;
});

export const ubahAi = (adminId: number, idRaw: unknown, input: UbahAiInput) => dalamTransaksi(async (conn) => {
  const id = idSah(idRaw);
  const sebelum = await ambil(conn, id, true);
  const sets: string[] = [];
  const args: unknown[] = [];
  for (const k of ["label", "model", "priority", "is_active"] as const) {
    if (input[k] !== undefined) sets.push(`${k} = ?`), args.push(input[k]);
  }
  if (input.api_key !== undefined) sets.push("api_key_enc = ?", "key_hint = ?"), args.push(enkripsi(input.api_key), input.api_key.slice(-4));
  // key/model baru atau diaktifkan lagi = mulai bersih, tidak menunggu istirahat lama
  if (input.api_key !== undefined || input.model !== undefined || input.is_active) sets.push("cooldown_until = NULL", "last_error = NULL", "last_error_at = NULL");
  await conn.query(`UPDATE ai_providers SET ${sets.join(", ")} WHERE id = ?`, [...args, id]);
  const sesudah = await ambil(conn, id);
  await catat(conn, { adminId, action: "ai.update", targetType: "ai_provider", targetId: id, before: sebelum, after: sesudah });
  return sesudah;
});

export const hapusAi = (adminId: number, idRaw: unknown) => dalamTransaksi(async (conn) => {
  const id = idSah(idRaw);
  const sebelum = await ambil(conn, id, true);
  await conn.query("DELETE FROM ai_providers WHERE id = ?", [id]);
  await catat(conn, { adminId, action: "ai.delete", targetType: "ai_provider", targetId: id, before: sebelum });
});

/** Uji koneksi satu penyedia dengan pertanyaan kecil; status penyedia ikut diperbarui. */
export async function ujiAi(idRaw: unknown) {
  const id = idSah(idRaw);
  const [[r]] = await db.query<RowDataPacket[]>("SELECT id, provider, label, model, api_key_enc FROM ai_providers WHERE id = ?", [id]);
  if (!r) throw tidakAda();
  const key = dekripsi(r.api_key_enc);
  const p: Penyedia = { id: r.id, jenis: r.provider, label: r.label, model: r.model, key: key ?? "" };
  if (!key) {
    await tandaiGagal(p, "API key tidak bisa dibuka (JWT_SECRET berubah?). Isi ulang key.", 3600);
    return { ok: false, message: "API key tidak bisa dibuka. Isi ulang key." };
  }
  const mulai = Date.now();
  try {
    const teks = await panggil(p, "Jawab sangat singkat.", "Balas dengan kata: OK");
    await tandaiOk(p);
    return { ok: true, ms: Date.now() - mulai, sample: teks.slice(0, 80) };
  } catch (e) {
    if (!(e instanceof GagalPenyedia)) throw e;
    await tandaiGagal(p, e.message, e.istirahatDetik);
    return { ok: false, message: e.message };
  }
}
