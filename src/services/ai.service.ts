import { ResultSetHeader, RowDataPacket } from "mysql2";
import db from "../config/db";
import { env } from "../config/env";
import { AppError } from "../utils/errors";
import { decrypt, encrypt } from "../utils/crypto";
import type { AiProviderInput, UpdateAiProviderInput } from "../dto/ai.dto";
import { recordAudit, withTransaction, type Conn } from "./admin-audit.service";
import { getWibDate } from "./merchant-quota.service";

// F22 AI gateway: penyedia dari DB (dikelola admin) dicoba urut prioritas; gagal (kuota/error/timeout) → istirahat sebentar
// → penyedia berikutnya. GEMINI_API_KEY di env = cadangan terakhir (perilaku F17 lama tetap jalan tanpa isian admin).
export const PROVIDER_TYPES = {
  gemini: { name: "Google Gemini (AI Studio)", url: "https://generativelanguage.googleapis.com/v1beta/models" },
  groq: { name: "Groq", url: "https://api.groq.com/openai/v1/chat/completions" },
  openrouter: { name: "OpenRouter", url: "https://openrouter.ai/api/v1/chat/completions" },
  nvidia: { name: "NVIDIA NIM", url: "https://integrate.api.nvidia.com/v1/chat/completions" },
} as const;
export type ProviderType = keyof typeof PROVIDER_TYPES;
type Provider = { id: number | null; type: ProviderType; label: string; model: string; key: string };
type TokenUsage = { prompt: number | null; completion: number | null; total: number | null };
/** Fitur pemakai AI (F25: dasbor pemakaian per fitur). */
export type AiContext = { feature: "asisten" | "rekomendasi" | "uji"; userId?: number | null };

class ProviderError extends Error {
  constructor(
    message: string,
    readonly cooldownSeconds: number,
  ) {
    super(message);
  }
}

// Kode jawaban → pesan untuk admin + lama istirahat. 429 memakai Retry-After bila ada (maks 1 jam).
async function postJson(url: string, init: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new ProviderError("Tidak menjawab (timeout/jaringan).", 30);
  }
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
  return res.json().catch(() => {
    throw new ProviderError("Jawaban penyedia tidak terbaca.", 30);
  });
}

const toInteger = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null);
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

// Gemini: REST generateContent (sama dengan F17); lainnya format OpenAI chat completions. Token dari usageMetadata / usage.
async function callProvider(
  provider: Provider,
  system: string,
  message: string,
): Promise<{ text: string; tokens: TokenUsage }> {
  let text: string | undefined;
  let tokens: TokenUsage;
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
  if (!text) throw new ProviderError("Jawaban penyedia kosong.", 30);
  return { text, tokens };
}

// F25: satu baris per percobaan; gagal mencatat tidak boleh menggagalkan jawaban AI
async function recordUsage(
  provider: Provider,
  context: AiContext,
  durationMs: number,
  outcome: { tokens?: TokenUsage; error?: string },
) {
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

// istirahat penyedia env disimpan di memori proses (tidak ada barisnya di DB)
let envCooldownUntil = 0;

async function markProviderOk(provider: Provider) {
  if (provider.id === null) envCooldownUntil = 0;
  else
    await db.query(
      "UPDATE ai_providers SET last_ok_at = UTC_TIMESTAMP(), cooldown_until = NULL, updated_at = updated_at WHERE id = ?",
      [provider.id],
    );
}

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

async function loadProviders(): Promise<{ ready: Provider[]; configured: boolean }> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, provider, label, model, api_key_enc, cooldown_until > UTC_TIMESTAMP() AS istirahat
     FROM ai_providers WHERE is_active ORDER BY priority, id`,
  );
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

/** Satu pintu AI untuk semua fitur (asisten penjual F17, rekomendasi pembeli F24). Objek agar test bisa memata-matai. */
export const ai = {
  async ask(system: string, message: string, context: AiContext): Promise<string> {
    const { ready, configured } = await loadProviders();
    if (!configured) throw new AppError(503, "SERVICE_UNAVAILABLE", "Asisten AI belum diaktifkan.");
    for (const provider of ready) {
      const startedAt = Date.now();
      try {
        const { text, tokens } = await callProvider(provider, system, message);
        await markProviderOk(provider);
        await recordUsage(provider, context, Date.now() - startedAt, { tokens });
        return text;
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        await markProviderFailed(provider, error.message, error.cooldownSeconds);
        await recordUsage(provider, context, Date.now() - startedAt, { error: error.message });
      }
    }
    throw new AppError(502, "UPSTREAM_ERROR", "Asisten AI sedang tidak bisa dihubungi. Coba lagi sebentar lagi.");
  },
};

// ---------- admin ----------
const PROVIDER_COLUMNS =
  "id, provider, label, model, key_hint, priority, is_active, last_ok_at, last_error, last_error_at, cooldown_until";
// API key tidak pernah keluar: hanya 4 karakter terakhir
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
const providerNotFound = () => new AppError(404, "NOT_FOUND", "Penyedia AI tidak ditemukan.");
const parseProviderId = (raw: unknown) => {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) throw providerNotFound();
  return id;
};
async function loadProvider(conn: Pick<Conn, "query">, id: number, forUpdate = false) {
  const [[row]] = await conn.query<RowDataPacket[]>(
    `SELECT ${PROVIDER_COLUMNS} FROM ai_providers WHERE id = ?${forUpdate ? " FOR UPDATE" : ""}`,
    [id],
  );
  if (!row) throw providerNotFound();
  return mapProvider(row);
}

export async function listAiProviders() {
  const [rows] = await db.query<RowDataPacket[]>(`SELECT ${PROVIDER_COLUMNS} FROM ai_providers ORDER BY priority, id`);
  return { providers: rows.map(mapProvider), env_gemini: env.GEMINI_API_KEY ? { model: env.GEMINI_MODEL } : null };
}

export const createAiProvider = (adminId: number, input: AiProviderInput) =>
  withTransaction(async (conn) => {
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

export const updateAiProvider = (adminId: number, idRaw: unknown, input: UpdateAiProviderInput) =>
  withTransaction(async (conn) => {
    const id = parseProviderId(idRaw);
    const before = await loadProvider(conn, id, true);
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const key of ["label", "model", "priority", "is_active"] as const) {
      if (input[key] !== undefined) (sets.push(`${key} = ?`), args.push(input[key]));
    }
    if (input.api_key !== undefined)
      (sets.push("api_key_enc = ?", "key_hint = ?"), args.push(encrypt(input.api_key), input.api_key.slice(-4)));
    // key/model baru atau diaktifkan lagi = mulai bersih, tidak menunggu istirahat lama
    if (input.api_key !== undefined || input.model !== undefined || input.is_active)
      sets.push("cooldown_until = NULL", "last_error = NULL", "last_error_at = NULL");
    await conn.query(`UPDATE ai_providers SET ${sets.join(", ")} WHERE id = ?`, [...args, id]);
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

export const deleteAiProvider = (adminId: number, idRaw: unknown) =>
  withTransaction(async (conn) => {
    const id = parseProviderId(idRaw);
    const before = await loadProvider(conn, id, true);
    await conn.query("DELETE FROM ai_providers WHERE id = ?", [id]);
    await recordAudit(conn, { adminId, action: "ai.delete", targetType: "ai_provider", targetId: id, before });
  });

/** Uji koneksi satu penyedia dengan pertanyaan kecil; status penyedia ikut diperbarui. */
export async function testAiProvider(idRaw: unknown) {
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

// ---------- F25 pemakaian (admin) ----------
const toNumber = (value: unknown) => Number(value ?? 0);
const toMsOrNull = (value: unknown) => (value === null || value === undefined ? null : Number(value));
const COUNT_COLUMNS_SQL =
  "COUNT(*) AS panggilan, COALESCE(SUM(NOT ok), 0) AS gagal, COALESCE(SUM(total_tokens), 0) AS token";
const AVG_LATENCY_SQL = "ROUND(AVG(CASE WHEN ok THEN latency_ms END)) AS rata_ms";

/** Ringkasan `hari` hari terakhir (WIB, termasuk hari ini): total, per penyedia, per fitur, per hari, 10 gagal terakhir. */
export async function getAiUsage(days: number) {
  const todayStart = Date.parse(`${getWibDate()}T00:00:00Z`);
  const dates = Array.from({ length: days }, (_, i) =>
    new Date(todayStart - (days - 1 - i) * 86400e3).toISOString().slice(0, 10),
  );
  const since = new Date(Date.parse(`${dates[0]}T00:00:00+07:00`));
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
