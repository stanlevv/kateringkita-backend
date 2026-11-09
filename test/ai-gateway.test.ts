import request from "supertest";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { env } from "../src/config/env";
import { createAdmin } from "../src/scripts/create-admin";
import { ai } from "../src/services/ai.service";
import { bersihkanLog } from "../src/services/log-server.service";
import { hariIniWib } from "../src/services/merchant-kuota.service";
import { dekripsi } from "../src/utils/kripto";
import { login, siapkanToko } from "./helpers/toko";

// F22 AI gateway: penyedia dikelola admin, key terenkripsi & tak pernah keluar, fallback berurutan dengan istirahat
let s: Awaited<ReturnType<typeof siapkanToko>>;
let tAdmin = "";
const URL_GROQ = "https://api.groq.com/openai/v1/chat/completions";
const URL_OR = "https://openrouter.ai/api/v1/chat/completions";
const URL_NIM = "https://integrate.api.nvidia.com/v1/chat/completions";
const api = (path = "", t = tAdmin) => ({
  get: () => request(app).get(`/api/v1/admin/ai-providers${path}`).set("Authorization", `Bearer ${t}`),
  post: (b?: unknown) => request(app).post(`/api/v1/admin/ai-providers${path}`).set("Authorization", `Bearer ${t}`).send(b as object),
  patch: (b: unknown) => request(app).patch(`/api/v1/admin/ai-providers${path}`).set("Authorization", `Bearer ${t}`).send(b as object),
  delete: () => request(app).delete(`/api/v1/admin/ai-providers${path}`).set("Authorization", `Bearer ${t}`),
});
const tambah = (o: Record<string, unknown>) =>
  api().post({ provider: "groq", label: "Groq", model: "llama-3.3-70b-versatile", api_key: "gsk_rahasia_1234567890ABCD", priority: 1, ...o }).expect(201);
const openai = (teks: string) => new Response(JSON.stringify({ choices: [{ message: { content: teks } }] }));
const baris = async (id: number) =>
  ((await db.query<any[]>("SELECT *, TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), cooldown_until) AS sisa FROM ai_providers WHERE id = ?", [id]))[0] as any[])[0];

beforeAll(async () => {
  s = await siapkanToko();
  await createAdmin({ phone: "081300000009", fullName: "Admin Uji", password: "rahasia123" });
  tAdmin = await login("081300000009");
});
afterEach(async () => {
  vi.unstubAllGlobals();
  env.GEMINI_API_KEY = undefined;
  await db.query("DELETE FROM ai_providers");
});

describe("admin mengelola penyedia AI", () => {
  test("key hanya 4 karakter terakhir, tersimpan terenkripsi, log tanpa key; validasi; penjual 403", async () => {
    const r = await tambah({ label: "  Groq gratis " });
    expect(r.body.data).toMatchObject({ provider: "groq", provider_name: "Groq", label: "Groq gratis", key_hint: "ABCD", priority: 1, is_active: true, last_error: null });
    expect(JSON.stringify(r.body)).not.toContain("rahasia");
    const b = await baris(r.body.data.id);
    expect(b.api_key_enc).not.toContain("rahasia");
    expect(dekripsi(b.api_key_enc)).toBe("gsk_rahasia_1234567890ABCD");
    const [[log]] = await db.query<any[]>("SELECT action, after_json FROM admin_audit_logs WHERE target_type = 'ai_provider'");
    expect(log.action).toBe("ai.create");
    expect(JSON.stringify(log.after_json)).not.toContain("rahasia");
    const v = await api().post({ provider: "openai", label: "", model: "a b", api_key: "pendek" }).expect(400);
    expect(Object.keys(v.body.error.fields).sort()).toEqual(["api_key", "label", "model", "provider"]);
    await api("", s.tA).get().expect(403);
    expect((await api().get().expect(200)).body.data).toMatchObject({ providers: [{ key_hint: "ABCD" }], env_gemini: null });
  });

  test("uji koneksi sukses/gagal memperbarui status; ganti key membersihkan error; hapus → 204 + log", async () => {
    const id = (await tambah({})).body.data.id;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(openai("OK")));
    expect((await api(`/${id}/test`).post().expect(200)).body.data).toMatchObject({ ok: true, sample: "OK" });
    expect((await baris(id)).last_ok_at).not.toBeNull();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 401 })));
    expect((await api(`/${id}/test`).post().expect(200)).body.data).toEqual({ ok: false, message: "API key ditolak (401)." });
    expect(Number((await baris(id)).sisa)).toBeGreaterThan(590);
    const u = (await api(`/${id}`).patch({ api_key: "gsk_kunci_baru_6789" }).expect(200)).body.data;
    expect(u).toMatchObject({ key_hint: "6789", last_error: null, cooldown_until: null });
    await api(`/${id}`).delete().expect(204);
    await api("/9999").delete().expect(404);
    const [aksi] = await db.query<any[]>("SELECT action FROM admin_audit_logs WHERE target_type = 'ai_provider' AND target_id = ? ORDER BY id", [String(id)]);
    expect((aksi as any[]).map((a) => a.action)).toEqual(["ai.create", "ai.update", "ai.delete"]);
  });
});

describe("gateway & fallback", () => {
  test("Groq kena 429 → istirahat sesuai Retry-After → OpenRouter menjawab; berikutnya langsung ke OpenRouter", async () => {
    const groq = (await tambah({ priority: 1 })).body.data.id;
    const or = (await tambah({ provider: "openrouter", label: "OR", model: "meta/llama:free", api_key: "sk-or-12345678", priority: 2 })).body.data.id;
    const fetch = vi.fn(async (url: string) => (url === URL_GROQ ? new Response("{}", { status: 429, headers: { "retry-after": "120" } }) : openai("Halo dari OR")));
    vi.stubGlobal("fetch", fetch);
    expect(await ai.tanya("sistem", "pesan", { fitur: "asisten" })).toBe("Halo dari OR");
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([URL_GROQ, URL_OR]);
    const init = fetch.mock.calls[1][1] as unknown as RequestInit & { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe("Bearer sk-or-12345678");
    expect(JSON.parse(init.body as string)).toMatchObject({ model: "meta/llama:free", messages: [{ role: "system", content: "sistem" }, { role: "user", content: "pesan" }] });
    const g = await baris(groq);
    expect(g.last_error).toBe("Kuota/batas pemakaian habis (429).");
    expect(Number(g.sisa)).toBeGreaterThan(100);
    expect((await baris(or)).last_ok_at).not.toBeNull();
    fetch.mockClear();
    expect(await ai.tanya("s", "p", { fitur: "asisten" })).toBe("Halo dari OR");
    expect(fetch).toHaveBeenCalledTimes(1);
    // asisten penjual memakai gateway yang sama
    expect((await request(app).post("/api/v1/merchant/assistant").set("Authorization", `Bearer ${s.tA}`).send({ question: "halo" }).expect(200)).body.data.answer).toBe("Halo dari OR");
  });

  test("tanpa penyedia → 503; nonaktif dilewati; GEMINI_API_KEY env cadangan terakhir; semua gagal → 502", async () => {
    await expect(ai.tanya("s", "p", { fitur: "asisten" })).rejects.toMatchObject({ status: 503 });
    await tambah({ priority: 1, is_active: false });
    await tambah({ provider: "nvidia", label: "NIM", model: "meta/llama-3.3-70b-instruct", api_key: "nvapi-1234567890", priority: 2 });
    env.GEMINI_API_KEY = "kunci-env";
    const fetch = vi.fn(async (url: string) => (url === URL_NIM
      ? new Response("{}", { status: 500 })
      : new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Halo env" }] } }] }))));
    vi.stubGlobal("fetch", fetch);
    expect(await ai.tanya("s", "p", { fitur: "asisten" })).toBe("Halo env");
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([URL_NIM, `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent`]);
    fetch.mockImplementation(async () => new Response("{}", { status: 500 }));
    await expect(ai.tanya("s", "p", { fitur: "asisten" })).rejects.toMatchObject({ status: 502 });
  });
});

describe("pemakaian AI (F25)", () => {
  const pakai = (qs = "", t = tAdmin) => request(app).get(`/api/v1/admin/ai-usage${qs}`).set("Authorization", `Bearer ${t}`);

  test("tiap percobaan tercatat (gagal & berhasil + token); uji koneksi = fitur uji; ringkasan admin", async () => {
    await db.query("DELETE FROM ai_usage");
    await tambah({ priority: 1 });
    const or = (await tambah({ provider: "openrouter", label: "OR", model: "meta/llama:free", api_key: "sk-or-12345678", priority: 2 })).body.data.id;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url === URL_GROQ
      ? new Response("{}", { status: 429 })
      : new Response(JSON.stringify({ choices: [{ message: { content: "Halo" } }], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } })))));
    expect(await ai.tanya("s", "p", { fitur: "rekomendasi", userId: 42 })).toBe("Halo");
    const [rows] = await db.query<any[]>("SELECT provider, label, fitur, ok, prompt_tokens, completion_tokens, total_tokens, error, user_id, latency_ms FROM ai_usage ORDER BY provider");
    expect(rows.map(({ latency_ms, ...r }: any) => ({ ...r, ms: latency_ms >= 0 }))).toEqual([
      { provider: "groq", label: "Groq", fitur: "rekomendasi", ok: 0, prompt_tokens: null, completion_tokens: null, total_tokens: null, error: "Kuota/batas pemakaian habis (429).", user_id: 42, ms: true },
      { provider: "openrouter", label: "OR", fitur: "rekomendasi", ok: 1, prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, error: null, user_id: 42, ms: true },
    ]);
    // total kosong dari penyedia → prompt + completion
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }], usage: { prompt_tokens: 7, completion_tokens: 1 } }))));
    await request(app).post(`/api/v1/admin/ai-providers/${or}/test`).set("Authorization", `Bearer ${tAdmin}`).expect(200);
    const [[uji]] = await db.query<any[]>("SELECT fitur, total_tokens, user_id FROM ai_usage WHERE fitur = 'uji'");
    expect(uji).toEqual({ fitur: "uji", total_tokens: 8, user_id: null });

    const d = (await pakai("?days=7").expect(200)).body.data;
    expect(d.hari).toBe(7);
    expect(d.ringkas).toMatchObject({ panggilan: 3, gagal: 1, token: 158, token_masuk: 127, token_keluar: 31 });
    expect(d.per_penyedia.map((p: any) => [p.label, p.panggilan, p.gagal, p.token])).toEqual([["OR", 2, 0, 158], ["Groq", 1, 1, 0]]);
    expect(d.per_fitur.map((f: any) => [f.fitur, f.panggilan, f.token])).toEqual([["rekomendasi", 2, 150], ["uji", 1, 8]]);
    expect(d.per_hari).toHaveLength(7);
    expect(d.per_hari.at(-1)).toEqual({ tanggal: hariIniWib(), panggilan: 3, gagal: 1, token: 158 });
    expect(d.per_hari.slice(0, 6).every((h: any) => h.panggilan === 0)).toBe(true);
    expect(d.gagal_terakhir).toMatchObject([{ label: "Groq", fitur: "rekomendasi", error: "Kuota/batas pemakaian habis (429)." }]);
    expect((await pakai("?days=abc").expect(200)).body.data.per_hari).toHaveLength(7);
    expect((await pakai("?days=30").expect(200)).body.data.per_hari).toHaveLength(30);
    await pakai("", s.tA).expect(403);
  });

  test("Gemini: token dari usageMetadata", async () => {
    await db.query("DELETE FROM ai_usage");
    const id = (await tambah({ provider: "gemini", label: "Gemini", model: "gemini-2.0-flash", api_key: "AIza-uji-1234567890" })).body.data.id;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "Hai" }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    }))));
    expect(await ai.tanya("s", "p", { fitur: "asisten", userId: 7 })).toBe("Hai");
    const [[r]] = await db.query<any[]>("SELECT provider_id, provider, label, prompt_tokens, completion_tokens, total_tokens FROM ai_usage");
    expect(r).toEqual({ provider_id: id, provider: "gemini", label: "Gemini", prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  test("pembersihan: riwayat pemakaian > 90 hari dihapus", async () => {
    await db.query("DELETE FROM ai_usage");
    for (const [label, hari] of [["lama", 91], ["baru", 89]] as const) {
      await db.query(
        "INSERT INTO ai_usage (provider, label, model, fitur, ok, latency_ms, created_at) VALUES ('groq', ?, 'm', 'asisten', TRUE, 1, UTC_TIMESTAMP() - INTERVAL ? DAY)",
        [label, hari],
      );
    }
    await bersihkanLog();
    expect((await db.query<any[]>("SELECT label FROM ai_usage"))[0]).toEqual([{ label: "baru" }]);
  });
});
