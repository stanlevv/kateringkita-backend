// Isi file: AI gateway, yaitu satu pintu untuk semua pemanggilan model AI (asisten penjual dan rekomendasi pembeli
// memanggil `ai.ask`), ditambah menu admin super untuk mengelola penyedia AI, menguji koneksi, dan melihat pemakaian
// (/admin/ai-providers, /admin/ai-usage). Alur admin: routes/admin.ts → handlers/ai.handler.ts → file ini → database.
//
// Istilah:
// - Penyedia AI: layanan model AI di internet (Gemini, Groq, OpenRouter, NVIDIA). Admin hanya memilih jenisnya;
//   alamat API-nya ditulis tetap di kode. API key disimpan terenkripsi dan tidak pernah dikirim balik utuh.
// - Urutan fallback: penyedia aktif dicoba satu per satu menurut `priority` (angka kecil dulu). Bila satu gagal
//   (kuota habis, key ditolak, error, atau tidak menjawab dalam 30 detik), penyedia itu diistirahatkan sebentar
//   (cooldown) lalu penyedia berikutnya dicoba. GEMINI_API_KEY di env menjadi cadangan paling akhir.
// - Token: satuan potongan teks yang dihitung penyedia; token masuk = panjang pertanyaan, token keluar = panjang
//   jawaban. Latensi = lama menunggu jawaban (milidetik). Keduanya dicatat per percobaan di tabel ai_usage.
import { ResultSetHeader, RowDataPacket } from "mysql2";
import db from "../config/db";
import { env } from "../config/env";
import { AppError } from "../utils/errors";
import { decrypt, encrypt } from "../utils/crypto";
import type { AiProviderInput, UpdateAiProviderInput } from "../dto/ai.dto";
import { recordAudit, withTransaction, type Conn } from "./admin-audit.service";
import { getWibDate } from "./merchant-quota.service";

/** Jenis penyedia yang dikenal: nama untuk ditampilkan dan alamat API tetap (tidak bisa diisi admin). */
export const PROVIDER_TYPES = {
  gemini: { name: "Google Gemini (AI Studio)", url: "https://generativelanguage.googleapis.com/v1beta/models" },
  groq: { name: "Groq", url: "https://api.groq.com/openai/v1/chat/completions" },
  openrouter: { name: "OpenRouter", url: "https://openrouter.ai/api/v1/chat/completions" },
  nvidia: { name: "NVIDIA NIM", url: "https://integrate.api.nvidia.com/v1/chat/completions" },
} as const;
/** Kunci jenis penyedia, sama dengan nilai kolom `ai_providers.provider`. */
export type ProviderType = keyof typeof PROVIDER_TYPES;
// Penyedia yang siap dipanggil; `id` null = penyedia cadangan dari env (tidak punya baris di database).
type Provider = { id: number | null; type: ProviderType; label: string; model: string; key: string };
// Jumlah token satu panggilan; null bila penyedia tidak melaporkannya.
type TokenUsage = { prompt: number | null; completion: number | null; total: number | null };
/**
 * Siapa yang memanggil AI, untuk dasbor pemakaian per fitur: `asisten` (asisten penjual), `rekomendasi` (rekomendasi
 * pembeli), atau `uji` (uji koneksi admin), beserta id pengguna bila ada.
 */
export type AiContext = { feature: "asisten" | "rekomendasi" | "uji"; userId?: number | null };

// Galat dari penyedia yang boleh dilewati ke penyedia berikutnya; membawa lama istirahat (detik) untuk penyedia itu.
class ProviderError extends Error {
  constructor(
    message: string,
    readonly cooldownSeconds: number,
  ) {
    super(message);
  }
}

// Mengirim POST ke penyedia (batas tunggu 30 detik) dan mengubah setiap kegagalan menjadi ProviderError berisi pesan
// untuk admin dan lama istirahat: tidak menjawab 30 dtk, kuota habis (429) sesuai header Retry-After bila ada (bawaan
// 60 dtk, maks 1 jam), key ditolak (401/403) atau model salah (400/404) 10 menit, error server 30 dtk.
async function postJson(url: string, init: RequestInit): Promise<any> {
  // 1. Kirim permintaan; gagal jaringan atau lewat batas waktu = penyedia tidak menjawab.
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new ProviderError("Tidak menjawab (timeout/jaringan).", 30);
  }
  // 2. Kode status selain 2xx diterjemahkan menjadi pesan dan lama istirahat.
  if (!res.ok) {
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      throw new ProviderError("Kuota/batas pemakaian habis (429).", Math.min(retryAfter > 0 ? retryAfter : 60, 3600));
    }
    if (res.status === 401 || res.status === 403) throw new ProviderError(`API key ditolak (${res.status}).`, 600);
    if (res.status === 400 || res.status === 404)
      throw new ProviderError(`Permintaan ditolak (${res.status}). Periksa nama model.`, 600);
    throw new ProviderError(`Server penyedia error (${res.status}).`, 30);
  }
  // 3. Jawaban harus JSON yang bisa dibaca.
  return res.json().catch(() => {
    throw new ProviderError("Jawaban penyedia tidak terbaca.", 30);
  });
}

// Angka valid dibulatkan; selain itu null.
const toInteger = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null);
// Menyusun jumlah token; total dihitung sendiri (masuk + keluar) bila penyedia tidak mengirimnya.
const toTokenUsage = (promptTokens: unknown, completionTokens: unknown, total: unknown): TokenUsage => {
  const promptCount = toInteger(promptTokens),
    completionCount = toInteger(completionTokens);
  return {
    prompt: promptCount,
    completion: completionCount,
    total:
      toInteger(total) ?? (promptCount !== null && completionCount !== null ? promptCount + completionCount : null),
  };
};

// Memanggil satu penyedia dengan prompt sistem (aturan untuk AI) dan pesan pengguna. Gemini memakai format
// generateContent milik Google; penyedia lain memakai format chat completions ala OpenAI. Jawaban kosong dianggap
// gagal.
async function callProvider(
  provider: Provider,
  system: string,
  message: string,
): Promise<{ text: string; tokens: TokenUsage }> {
  let text: string | undefined;
  let tokens: TokenUsage;
  // 1. Gemini: teks jawaban dari candidates, token dari usageMetadata.
  if (provider.type === "gemini") {
    const body = await postJson(`${PROVIDER_TYPES.gemini.url}/${encodeURIComponent(provider.model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": provider.key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: message }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 1024 },
      }),
    });
    text = body?.candidates?.[0]?.content?.parts
      ?.map((part: { text?: string }) => part.text ?? "")
      .join("")
      .trim();
    tokens = toTokenUsage(
      body?.usageMetadata?.promptTokenCount,
      body?.usageMetadata?.candidatesTokenCount,
      body?.usageMetadata?.totalTokenCount,
    );
  } else {
    // 2. Penyedia lain: teks jawaban dari choices, token dari usage.
    const body = await postJson(PROVIDER_TYPES[provider.type].url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.key}`,
        ...(provider.type === "openrouter" ? { "X-Title": "KateringKita" } : {}),
      },
      body: JSON.stringify({
        model: provider.model,
        temperature: 0.4,
        max_tokens: 1024,
        messages: [
          { role: "system", content: system },
          { role: "user", content: message },
        ],
      }),
    });
    text = body?.choices?.[0]?.message?.content?.trim();
    tokens = toTokenUsage(body?.usage?.prompt_tokens, body?.usage?.completion_tokens, body?.usage?.total_tokens);
  }
  // 3. Jawaban kosong = gagal, supaya penyedia berikutnya dicoba.
  if (!text) throw new ProviderError("Jawaban penyedia kosong.", 30);
  return { text, tokens };
}

// Mencatat satu percobaan ke tabel ai_usage (berhasil atau gagal, latensi, token, pesan galat). Gagal mencatat hanya
// ditulis ke log konsol dan tidak boleh menggagalkan jawaban AI.
async function recordUsage(
  provider: Provider,
  context: AiContext,
  durationMs: number,
  outcome: { tokens?: TokenUsage; error?: string },
) {
  // 1. Satu INSERT; teks dipotong sesuai panjang kolom. Galat penyimpanan ditangkap dan hanya ditulis ke log.
  await db
    .query(
      `INSERT INTO ai_usage (provider_id, provider, label, model, fitur, ok, latency_ms, prompt_tokens, completion_tokens, total_tokens, error, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        provider.id,
        provider.type,
        provider.label.slice(0, 60),
        provider.model.slice(0, 120),
        context.feature,
        !outcome.error,
        durationMs,
        outcome.tokens?.prompt ?? null,
        outcome.tokens?.completion ?? null,
        outcome.tokens?.total ?? null,
        outcome.error?.slice(0, 255) ?? null,
        context.userId ?? null,
      ],
    )
    .catch((error) => console.error("[ai] gagal mencatat pemakaian:", (error as Error).message));
}

// Waktu selesai istirahat penyedia cadangan env; disimpan di memori proses karena penyedia itu tidak punya baris di DB.
let envCooldownUntil = 0;

// Penyedia berhasil menjawab: catat waktu berhasil dan hapus istirahatnya.
async function markProviderOk(provider: Provider) {
  if (provider.id === null) envCooldownUntil = 0;
  else
    await db.query(
      "UPDATE ai_providers SET last_ok_at = UTC_TIMESTAMP(), cooldown_until = NULL, updated_at = updated_at WHERE id = ?",
      [provider.id],
    );
}

// Penyedia gagal: catat pesan galatnya dan istirahatkan selama `seconds` detik.
async function markProviderFailed(provider: Pick<Provider, "id" | "label">, message: string, seconds: number) {
  console.error(`AI ${provider.label}: ${message} → istirahat ${seconds} dtk`);
  if (provider.id === null) envCooldownUntil = Date.now() + seconds * 1000;
  else {
    await db.query(
      `UPDATE ai_providers SET last_error = ?, last_error_at = UTC_TIMESTAMP(), cooldown_until = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND),
         updated_at = updated_at WHERE id = ?`,
      [message.slice(0, 255), seconds, provider.id],
    );
  }
}

// Daftar penyedia yang siap dipanggil, urut prioritas: yang aktif, tidak sedang istirahat, dan key-nya bisa dibuka;
// cadangan env ditaruh paling akhir. `configured` = ada penyedia yang diatur sama sekali (walau semua sedang
// istirahat), untuk membedakan "AI belum diaktifkan" (503) dari "AI sedang tidak bisa dihubungi" (502).
async function loadProviders(): Promise<{ ready: Provider[]; configured: boolean }> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, provider, label, model, api_key_enc, cooldown_until > UTC_TIMESTAMP() AS istirahat
     FROM ai_providers WHERE is_active ORDER BY priority, id`,
  );
  // 1. Penyedia dari database: lewati yang istirahat; key yang tidak bisa dibuka membuat penyedia diistirahatkan 1 jam.
  const ready: Provider[] = [];
  for (const row of rows) {
    if (Number(row.istirahat)) continue;
    const key = decrypt(row.api_key_enc);
    if (key) ready.push({ id: row.id, type: row.provider, label: row.label, model: row.model, key });
    else
      await markProviderFailed(
        { id: row.id, label: row.label },
        "API key tidak bisa dibuka (JWT_SECRET berubah?). Isi ulang key.",
        3600,
      );
  }
  // 2. Cadangan terakhir dari env, bila diisi dan tidak sedang istirahat.
  if (env.GEMINI_API_KEY && Date.now() >= envCooldownUntil) {
    ready.push({
      id: null,
      type: "gemini",
      label: "GEMINI_API_KEY (env)",
      model: env.GEMINI_MODEL,
      key: env.GEMINI_API_KEY,
    });
  }
  return { ready, configured: rows.length > 0 || !!env.GEMINI_API_KEY };
}

/**
 * Satu pintu AI untuk semua fitur (asisten penjual dan rekomendasi pembeli). Dibuat sebagai objek supaya test bisa
 * menggantinya dengan jawaban palsu (`vi.spyOn(ai, "ask")`).
 */
export const ai = {
  /**
   * Mengirim pertanyaan ke penyedia AI menurut urutan fallback dan mengembalikan jawaban pertama yang berhasil.
   * Setiap percobaan dicatat di tabel ai_usage.
   * @param system  prompt sistem: aturan dan peran untuk AI
   * @param message pesan pengguna yang sudah disiapkan pemanggil
   * @param context fitur pemanggil dan id pengguna, untuk pencatatan pemakaian
   * @returns teks jawaban AI
   * @throws 503 bila belum ada penyedia yang diatur sama sekali, 502 bila semua penyedia gagal atau sedang istirahat
   */
  async ask(system: string, message: string, context: AiContext): Promise<string> {
    // 1. Ambil penyedia yang siap; tanpa penyedia sama sekali = fitur AI belum diaktifkan.
    const { ready, configured } = await loadProviders();
    if (!configured) throw new AppError(503, "SERVICE_UNAVAILABLE", "Asisten AI belum diaktifkan.");
    // 2. Coba satu per satu; berhasil = tandai sehat, catat, dan kembalikan jawaban.
    for (const provider of ready) {
      const startedAt = Date.now();
      try {
        const { text, tokens } = await callProvider(provider, system, message);
        await markProviderOk(provider);
        await recordUsage(provider, context, Date.now() - startedAt, { tokens });
        return text;
      } catch (error) {
        // 3. Gagal dari penyedia: istirahatkan, catat, lalu lanjut ke penyedia berikutnya. Galat lain diteruskan.
        if (!(error instanceof ProviderError)) throw error;
        await markProviderFailed(provider, error.message, error.cooldownSeconds);
        await recordUsage(provider, context, Date.now() - startedAt, { error: error.message });
      }
    }
    // 4. Semua penyedia gagal.
    throw new AppError(502, "UPSTREAM_ERROR", "Asisten AI sedang tidak bisa dihubungi. Coba lagi sebentar lagi.");
  },
};

// ---------- admin ----------
// Kolom penyedia yang boleh tampil di panel admin (tanpa API key terenkripsi).
const PROVIDER_COLUMNS =
  "id, provider, label, model, key_hint, priority, is_active, last_ok_at, last_error, last_error_at, cooldown_until";
// Baris penyedia menjadi JSON panel admin. API key tidak pernah dikirim; hanya 4 karakter terakhirnya (`key_hint`).
const mapProvider = (row: RowDataPacket) => ({
  id: row.id,
  provider: row.provider as ProviderType,
  provider_name: PROVIDER_TYPES[row.provider as ProviderType].name,
  label: row.label,
  model: row.model,
  key_hint: row.key_hint,
  priority: row.priority,
  is_active: Boolean(row.is_active),
  last_ok_at: row.last_ok_at,
  last_error: row.last_error,
  last_error_at: row.last_error_at,
  cooldown_until: row.cooldown_until,
});
// Galat 404 penyedia tidak ditemukan; id yang bukan bilangan bulat positif juga dianggap tidak ada.
const providerNotFound = () => new AppError(404, "NOT_FOUND", "Penyedia AI tidak ditemukan.");
const parseProviderId = (raw: unknown) => {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) throw providerNotFound();
  return id;
};
// Membaca satu penyedia (dikunci bila `forUpdate`) untuk isi sebelum/sesudah di log audit.
async function loadProvider(conn: Pick<Conn, "query">, id: number, forUpdate = false) {
  const [[row]] = await conn.query<RowDataPacket[]>(
    `SELECT ${PROVIDER_COLUMNS} FROM ai_providers WHERE id = ?${forUpdate ? " FOR UPDATE" : ""}`,
    [id],
  );
  if (!row) throw providerNotFound();
  return mapProvider(row);
}

/**
 * Daftar penyedia AI urut prioritas, beserta keterangan penyedia cadangan dari env bila diisi.
 * @returns `{ providers, env_gemini }`; `env_gemini` berisi nama model cadangan, atau null bila env tidak diisi
 */
export async function listAiProviders() {
  const [rows] = await db.query<RowDataPacket[]>(`SELECT ${PROVIDER_COLUMNS} FROM ai_providers ORDER BY priority, id`);
  return { providers: rows.map(mapProvider), env_gemini: env.GEMINI_API_KEY ? { model: env.GEMINI_MODEL } : null };
}

/**
 * Menambah penyedia AI. API key disimpan terenkripsi beserta 4 karakter terakhirnya untuk ditampilkan. Dicatat di log
 * audit `ai.create` (tanpa API key).
 * @param adminId id admin super yang menambah
 * @param input   isi yang sudah diperiksa aiProviderSchema
 * @returns penyedia baru
 */
export const createAiProvider = (adminId: number, input: AiProviderInput) =>
  withTransaction(async (conn) => {
    // 1. Simpan penyedia dengan API key terenkripsi.
    const [result] = await conn.query<ResultSetHeader>(
      "INSERT INTO ai_providers (provider, label, model, api_key_enc, key_hint, priority, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        input.provider,
        input.label,
        input.model,
        encrypt(input.api_key),
        input.api_key.slice(-4),
        input.priority,
        input.is_active,
      ],
    );
    // 2. Baca ulang dan catat di log audit.
    const created = await loadProvider(conn, result.insertId);
    await recordAudit(conn, {
      adminId,
      action: "ai.create",
      targetType: "ai_provider",
      targetId: result.insertId,
      after: created,
    });
    return created;
  });

/**
 * Mengubah sebagian isi penyedia AI (jenis penyedia tidak bisa diganti). Key atau model baru, atau penyedia yang
 * diaktifkan lagi, mulai bersih: istirahat dan galat terakhirnya dihapus. Dicatat di log audit `ai.update`.
 * @param adminId id admin super yang mengubah
 * @param idRaw   id penyedia dari URL
 * @param input   kolom yang diubah, sudah diperiksa updateAiProviderSchema
 * @returns penyedia sesudah diubah
 * @throws 404 penyedia tidak ditemukan
 */
export const updateAiProvider = (adminId: number, idRaw: unknown, input: UpdateAiProviderInput) =>
  withTransaction(async (conn) => {
    // 1. Kunci penyedia dan simpan isi sebelumnya.
    const id = parseProviderId(idRaw);
    const before = await loadProvider(conn, id, true);
    // 2. Susun kolom yang diubah; key baru dienkripsi.
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const key of ["label", "model", "priority", "is_active"] as const) {
      if (input[key] !== undefined) (sets.push(`${key} = ?`), args.push(input[key]));
    }
    if (input.api_key !== undefined)
      (sets.push("api_key_enc = ?", "key_hint = ?"), args.push(encrypt(input.api_key), input.api_key.slice(-4)));
    // 3. Key/model baru atau diaktifkan lagi = mulai bersih, tidak menunggu istirahat lama.
    if (input.api_key !== undefined || input.model !== undefined || input.is_active)
      sets.push("cooldown_until = NULL", "last_error = NULL", "last_error_at = NULL");
    await conn.query(`UPDATE ai_providers SET ${sets.join(", ")} WHERE id = ?`, [...args, id]);
    // 4. Baca ulang dan catat isi sebelum/sesudah di log audit.
    const after = await loadProvider(conn, id);
    await recordAudit(conn, {
      adminId,
      action: "ai.update",
      targetType: "ai_provider",
      targetId: id,
      before,
      after,
    });
    return after;
  });

/**
 * Menghapus penyedia AI. Riwayat pemakaiannya di ai_usage tetap ada. Dicatat di log audit `ai.delete` beserta isi
 * sebelumnya.
 * @param adminId id admin super yang menghapus
 * @param idRaw   id penyedia dari URL
 * @returns selesai setelah terhapus
 * @throws 404 penyedia tidak ditemukan
 */
export const deleteAiProvider = (adminId: number, idRaw: unknown) =>
  withTransaction(async (conn) => {
    const id = parseProviderId(idRaw);
    const before = await loadProvider(conn, id, true);
    await conn.query("DELETE FROM ai_providers WHERE id = ?", [id]);
    await recordAudit(conn, { adminId, action: "ai.delete", targetType: "ai_provider", targetId: id, before });
  });

/**
 * Menguji koneksi satu penyedia dengan pertanyaan kecil ("Balas dengan kata: OK"). Status sehat/istirahat penyedia ikut
 * diperbarui dan percobaannya dicatat sebagai fitur `uji`. Penyedia nonaktif pun bisa diuji.
 * @param idRaw id penyedia dari URL
 * @returns `{ ok: true, ms, sample }` bila berhasil (ms = latensi), atau `{ ok: false, message }` bila gagal
 * @throws 404 penyedia tidak ditemukan
 */
export async function testAiProvider(idRaw: unknown) {
  // 1. Ambil penyedia dan buka API key-nya; key yang tidak bisa dibuka membuat penyedia diistirahatkan 1 jam.
  const id = parseProviderId(idRaw);
  const [[row]] = await db.query<RowDataPacket[]>(
    "SELECT id, provider, label, model, api_key_enc FROM ai_providers WHERE id = ?",
    [id],
  );
  if (!row) throw providerNotFound();
  const key = decrypt(row.api_key_enc);
  const provider: Provider = { id: row.id, type: row.provider, label: row.label, model: row.model, key: key ?? "" };
  if (!key) {
    await markProviderFailed(provider, "API key tidak bisa dibuka (JWT_SECRET berubah?). Isi ulang key.", 3600);
    return { ok: false, message: "API key tidak bisa dibuka. Isi ulang key." };
  }
  // 2. Kirim pertanyaan uji; berhasil atau gagal sama-sama dicatat dan status penyedia diperbarui.
  const startedAt = Date.now();
  try {
    const { text, tokens } = await callProvider(provider, "Jawab sangat singkat.", "Balas dengan kata: OK");
    await markProviderOk(provider);
    await recordUsage(provider, { feature: "uji" }, Date.now() - startedAt, { tokens });
    return { ok: true, ms: Date.now() - startedAt, sample: text.slice(0, 80) };
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    await markProviderFailed(provider, error.message, error.cooldownSeconds);
    await recordUsage(provider, { feature: "uji" }, Date.now() - startedAt, { error: error.message });
    return { ok: false, message: error.message };
  }
}

// ---------- pemakaian AI (admin) ----------
// Pembantu angka hasil SUM/AVG (MySQL bisa mengirimnya sebagai teks atau null).
const toNumber = (value: unknown) => Number(value ?? 0);
const toMsOrNull = (value: unknown) => (value === null || value === undefined ? null : Number(value));
// Kolom hitungan yang dipakai beberapa query: jumlah panggilan, yang gagal, dan total token.
const COUNT_COLUMNS_SQL =
  "COUNT(*) AS panggilan, COALESCE(SUM(NOT ok), 0) AS gagal, COALESCE(SUM(total_tokens), 0) AS token";
// Rata-rata latensi, hanya dari panggilan yang berhasil.
const AVG_LATENCY_SQL = "ROUND(AVG(CASE WHEN ok THEN latency_ms END)) AS rata_ms";

/**
 * Ringkasan pemakaian AI selama beberapa hari terakhir menurut tanggal WIB, termasuk hari ini. Kunci JSON jawabannya
 * berbahasa Indonesia karena itu kontrak dengan panel admin.
 * @param days jumlah hari (1–90, sudah diperiksa aiUsageSchema)
 * @returns `ringkas` (total panggilan, gagal, token, token masuk/keluar, rata-rata latensi), `per_penyedia`,
 *          `per_fitur`, `per_hari` (setiap tanggal muncul, yang kosong bernilai 0), dan `gagal_terakhir` (10 terakhir)
 */
export async function getAiUsage(days: number) {
  // 1. Susun daftar tanggal WIB dari yang tertua sampai hari ini, dan waktu mulai (00.00 WIB tanggal tertua).
  const todayStart = Date.parse(`${getWibDate()}T00:00:00Z`);
  const dates = Array.from({ length: days }, (_, i) =>
    new Date(todayStart - (days - 1 - i) * 86400e3).toISOString().slice(0, 10),
  );
  const since = new Date(Date.parse(`${dates[0]}T00:00:00+07:00`));
  // 2. Jalankan lima query ringkasan bersamaan, semuanya sejak waktu mulai yang sama.
  const runQuery = (sql: string) => db.query<RowDataPacket[]>(sql, [since]).then(([rows]) => rows);
  const [[totals], providerRows, featureRows, dailyRows, failedRows] = await Promise.all([
    runQuery(`SELECT ${COUNT_COLUMNS_SQL}, COALESCE(SUM(prompt_tokens), 0) AS token_masuk, COALESCE(SUM(completion_tokens), 0) AS token_keluar, ${AVG_LATENCY_SQL}
       FROM ai_usage WHERE created_at >= ?`),
    runQuery(`SELECT provider_id, provider, label, model, ${COUNT_COLUMNS_SQL}, ${AVG_LATENCY_SQL}, MAX(created_at) AS terakhir FROM ai_usage WHERE created_at >= ?
       GROUP BY provider_id, provider, label, model ORDER BY token DESC, panggilan DESC`),
    runQuery(
      `SELECT fitur, ${COUNT_COLUMNS_SQL} FROM ai_usage WHERE created_at >= ? GROUP BY fitur ORDER BY token DESC, panggilan DESC`,
    ),
    runQuery(
      `SELECT DATE_FORMAT(DATE_ADD(created_at, INTERVAL 7 HOUR), '%Y-%m-%d') AS tanggal, ${COUNT_COLUMNS_SQL} FROM ai_usage WHERE created_at >= ? GROUP BY tanggal`,
    ),
    runQuery(
      "SELECT created_at, label, model, fitur, error FROM ai_usage WHERE created_at >= ? AND NOT ok ORDER BY created_at DESC, id DESC LIMIT 10",
    ),
  ]);
  // 3. Rapikan angka; per hari diisi dari daftar tanggal supaya hari tanpa pemakaian tetap muncul.
  const rowsByDate = new Map(dailyRows.map((row) => [String(row.tanggal), row]));
  return {
    hari: days,
    ringkas: {
      panggilan: toNumber(totals.panggilan),
      gagal: toNumber(totals.gagal),
      token: toNumber(totals.token),
      token_masuk: toNumber(totals.token_masuk),
      token_keluar: toNumber(totals.token_keluar),
      rata_ms: toMsOrNull(totals.rata_ms),
    },
    per_penyedia: providerRows.map((row) => ({
      provider_id: row.provider_id,
      provider: row.provider as ProviderType,
      label: row.label,
      model: row.model,
      panggilan: toNumber(row.panggilan),
      gagal: toNumber(row.gagal),
      token: toNumber(row.token),
      rata_ms: toMsOrNull(row.rata_ms),
      terakhir: row.terakhir,
    })),
    per_fitur: featureRows.map((row) => ({
      fitur: row.fitur,
      panggilan: toNumber(row.panggilan),
      gagal: toNumber(row.gagal),
      token: toNumber(row.token),
    })),
    per_hari: dates.map((date) => {
      const row = rowsByDate.get(date);
      return {
        tanggal: date,
        panggilan: toNumber(row?.panggilan),
        gagal: toNumber(row?.gagal),
        token: toNumber(row?.token),
      };
    }),
    gagal_terakhir: failedRows.map((row) => ({
      created_at: row.created_at,
      label: row.label,
      model: row.model,
      fitur: row.fitur,
      error: row.error,
    })),
  };
}
