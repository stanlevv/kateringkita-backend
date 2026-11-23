import request from "supertest";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { env } from "../src/config/env";
import { createAdmin } from "../src/scripts/create-admin";
import { ai } from "../src/services/ai.service";
import { cleanupServerLogs } from "../src/services/server-log.service";
import { getWibDate } from "../src/services/merchant-quota.service";
import { decrypt } from "../src/utils/crypto";
import { login, prepareMerchants } from "./helpers/merchant";

// AI gateway: penyedia dikelola admin, key terenkripsi & tak pernah keluar, fallback berurutan dengan istirahat
let setup: Awaited<ReturnType<typeof prepareMerchants>>;
let adminToken = "";
const URL_GROQ = "https://api.groq.com/openai/v1/chat/completions";
const URL_OR = "https://openrouter.ai/api/v1/chat/completions";
const URL_NIM = "https://integrate.api.nvidia.com/v1/chat/completions";
const api = (path = "", token = adminToken) => ({
  get: () => request(app).get(`/api/v1/admin/ai-providers${path}`).set("Authorization", `Bearer ${token}`),
  post: (body?: unknown) =>
    request(app)
      .post(`/api/v1/admin/ai-providers${path}`)
      .set("Authorization", `Bearer ${token}`)
      .send(body as object),
  patch: (body: unknown) =>
    request(app)
      .patch(`/api/v1/admin/ai-providers${path}`)
      .set("Authorization", `Bearer ${token}`)
      .send(body as object),
  delete: () => request(app).delete(`/api/v1/admin/ai-providers${path}`).set("Authorization", `Bearer ${token}`),
});
const tambah = (overrides: Record<string, unknown>) =>
  api()
    .post({
      provider: "groq",
      label: "Groq",
      model: "llama-3.3-70b-versatile",
      api_key: "gsk_rahasia_1234567890ABCD",
      priority: 1,
      ...overrides,
    })
    .expect(201);
const openai = (teks: string) => new Response(JSON.stringify({ choices: [{ message: { content: teks } }] }));
const baris = async (id: number) =>
  (
    (
      await db.query<any[]>(
        "SELECT *, TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), cooldown_until) AS sisa FROM ai_providers WHERE id = ?",
        [id],
      )
    )[0] as any[]
  )[0];

beforeAll(async () => {
  setup = await prepareMerchants();
  await createAdmin({ phone: "081300000009", fullName: "Admin Uji", password: "rahasia123" });
  adminToken = await login("081300000009");
});
afterEach(async () => {
  vi.unstubAllGlobals();
  env.GEMINI_API_KEY = undefined;
  await db.query("DELETE FROM ai_providers");
});

describe("admin mengelola penyedia AI", () => {
  test("key hanya 4 karakter terakhir, tersimpan terenkripsi, log tanpa key; validasi; penjual 403", async () => {
    const res = await tambah({ label: "  Groq gratis " });
    expect(res.body.data).toMatchObject({
      provider: "groq",
      provider_name: "Groq",
      label: "Groq gratis",
      key_hint: "ABCD",
      priority: 1,
      is_active: true,
      last_error: null,
    });
    expect(JSON.stringify(res.body)).not.toContain("rahasia");
    const row = await baris(res.body.data.id);
    expect(row.api_key_enc).not.toContain("rahasia");
    expect(decrypt(row.api_key_enc)).toBe("gsk_rahasia_1234567890ABCD");
    const [[log]] = await db.query<any[]>(
      "SELECT action, after_json FROM admin_audit_logs WHERE target_type = 'ai_provider'",
    );
    expect(log.action).toBe("ai.create");
    expect(JSON.stringify(log.after_json)).not.toContain("rahasia");
    const invalidRes = await api().post({ provider: "openai", label: "", model: "a b", api_key: "pendek" }).expect(400);
    expect(Object.keys(invalidRes.body.error.fields).sort()).toEqual(["api_key", "label", "model", "provider"]);
    await api("", setup.tokenA).get().expect(403);
    expect((await api().get().expect(200)).body.data).toMatchObject({
      providers: [{ key_hint: "ABCD" }],
      env_gemini: null,
    });
  });

  test("uji koneksi sukses/gagal memperbarui status; ganti key membersihkan error; hapus → 204 + log", async () => {
    const id = (await tambah({})).body.data.id;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(openai("OK")));
    expect((await api(`/${id}/test`).post().expect(200)).body.data).toMatchObject({ ok: true, sample: "OK" });
    expect((await baris(id)).last_ok_at).not.toBeNull();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 401 })));
    expect((await api(`/${id}/test`).post().expect(200)).body.data).toEqual({
      ok: false,
      message: "API key ditolak (401).",
    });
    expect(Number((await baris(id)).sisa)).toBeGreaterThan(590);
    const updated = (await api(`/${id}`).patch({ api_key: "gsk_kunci_baru_6789" }).expect(200)).body.data;
    expect(updated).toMatchObject({ key_hint: "6789", last_error: null, cooldown_until: null });
    await api(`/${id}`).delete().expect(204);
    await api("/9999").delete().expect(404);
    const [aksi] = await db.query<any[]>(
      "SELECT action FROM admin_audit_logs WHERE target_type = 'ai_provider' AND target_id = ? ORDER BY id",
      [String(id)],
    );
    expect((aksi as any[]).map((entry) => entry.action)).toEqual(["ai.create", "ai.update", "ai.delete"]);
  });
});

describe("gateway & fallback", () => {
  test("Groq kena 429 → istirahat sesuai Retry-After → OpenRouter menjawab; berikutnya langsung ke OpenRouter", async () => {
    const groq = (await tambah({ priority: 1 })).body.data.id;
    const openRouterId = (
      await tambah({
        provider: "openrouter",
        label: "OR",
        model: "meta/llama:free",
        api_key: "sk-or-12345678",
        priority: 2,
      })
    ).body.data.id;
    const fetch = vi.fn(async (url: string, _init?: RequestInit) =>
      url === URL_GROQ
        ? new Response("{}", { status: 429, headers: { "retry-after": "120" } })
        : openai("Halo dari OR"),
    );
    vi.stubGlobal("fetch", fetch);
    expect(await ai.ask("sistem", "pesan", { feature: "asisten" })).toBe("Halo dari OR");
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([URL_GROQ, URL_OR]);
    const init = fetch.mock.calls[1][1] as unknown as RequestInit & { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe("Bearer sk-or-12345678");
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: "meta/llama:free",
      messages: [
        { role: "system", content: "sistem" },
        { role: "user", content: "pesan" },
      ],
    });
    const groqRow = await baris(groq);
    expect(groqRow.last_error).toBe("Kuota/batas pemakaian habis (429).");
    expect(Number(groqRow.sisa)).toBeGreaterThan(100);
    expect((await baris(openRouterId)).last_ok_at).not.toBeNull();
    fetch.mockClear();
    expect(await ai.ask("s", "p", { feature: "asisten" })).toBe("Halo dari OR");
    expect(fetch).toHaveBeenCalledTimes(1);
    // asisten penjual memakai gateway yang sama (jawaban asisten wajib JSON sesuai Output Schema)
    fetch.mockImplementation(async () => openai(JSON.stringify({ jawaban: "Halo dari OR", poin: [], asumsi: "" })));
    expect(
      (
        await request(app)
          .post("/api/v1/merchant/assistant")
          .set("Authorization", `Bearer ${setup.tokenA}`)
          .send({ question: "halo" })
          .expect(200)
      ).body.data.answer,
    ).toBe("Halo dari OR");
    expect(fetch.mock.calls.at(-1)?.[0]).toBe(URL_OR); // Groq masih istirahat
  });

  test("tanpa penyedia → 503; nonaktif dilewati; GEMINI_API_KEY env cadangan terakhir; semua gagal → 502", async () => {
    await expect(ai.ask("s", "p", { feature: "asisten" })).rejects.toMatchObject({ status: 503 });
    await tambah({ priority: 1, is_active: false });
    await tambah({
      provider: "nvidia",
      label: "NIM",
      model: "meta/llama-3.3-70b-instruct",
      api_key: "nvapi-1234567890",
      priority: 2,
    });
    env.GEMINI_API_KEY = "kunci-env";
    const fetch = vi.fn(async (url: string, _init?: RequestInit) =>
      url === URL_NIM
        ? new Response("{}", { status: 500 })
        : new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Halo env" }] } }] })),
    );
    vi.stubGlobal("fetch", fetch);
    expect(await ai.ask("s", "p", { feature: "asisten" })).toBe("Halo env");
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      URL_NIM,
      `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent`,
    ]);
    fetch.mockImplementation(async () => new Response("{}", { status: 500 }));
    await expect(ai.ask("s", "p", { feature: "asisten" })).rejects.toMatchObject({ status: 502 });
  });
});

describe("pemakaian AI", () => {
  const pakai = (query = "", token = adminToken) =>
    request(app).get(`/api/v1/admin/ai-usage${query}`).set("Authorization", `Bearer ${token}`);

  test("tiap percobaan tercatat (gagal & berhasil + token); uji koneksi = fitur uji; ringkasan admin", async () => {
    await db.query("DELETE FROM ai_usage");
    await tambah({ priority: 1 });
    const openRouterId = (
      await tambah({
        provider: "openrouter",
        label: "OR",
        model: "meta/llama:free",
        api_key: "sk-or-12345678",
        priority: 2,
      })
    ).body.data.id;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, _init?: RequestInit) =>
        url === URL_GROQ
          ? new Response("{}", { status: 429 })
          : new Response(
              JSON.stringify({
                choices: [{ message: { content: "Halo" } }],
                usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
              }),
            ),
      ),
    );
    expect(await ai.ask("s", "p", { feature: "rekomendasi", userId: 42 })).toBe("Halo");
    const [rows] = await db.query<any[]>(
      "SELECT provider, label, fitur, ok, prompt_tokens, completion_tokens, total_tokens, error, user_id, latency_ms FROM ai_usage ORDER BY provider",
    );
    expect(rows.map(({ latency_ms, ...rest }: any) => ({ ...rest, hasLatency: latency_ms >= 0 }))).toEqual([
      {
        provider: "groq",
        label: "Groq",
        fitur: "rekomendasi",
        ok: 0,
        prompt_tokens: null,
        completion_tokens: null,
        total_tokens: null,
        error: "Kuota/batas pemakaian habis (429).",
        user_id: 42,
        hasLatency: true,
      },
      {
        provider: "openrouter",
        label: "OR",
        fitur: "rekomendasi",
        ok: 1,
        prompt_tokens: 120,
        completion_tokens: 30,
        total_tokens: 150,
        error: null,
        user_id: 42,
        hasLatency: true,
      },
    ]);
    // total kosong dari penyedia → prompt + completion
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "OK" } }],
            usage: { prompt_tokens: 7, completion_tokens: 1 },
          }),
        ),
      ),
    );
    await request(app)
      .post(`/api/v1/admin/ai-providers/${openRouterId}/test`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
    const [[uji]] = await db.query<any[]>("SELECT fitur, total_tokens, user_id FROM ai_usage WHERE fitur = 'uji'");
    expect(uji).toEqual({ fitur: "uji", total_tokens: 8, user_id: null });

    const usage = (await pakai("?days=7").expect(200)).body.data;
    expect(usage.hari).toBe(7);
    expect(usage.ringkas).toMatchObject({ panggilan: 3, gagal: 1, token: 158, token_masuk: 127, token_keluar: 31 });
    expect(
      usage.per_penyedia.map((provider: any) => [provider.label, provider.panggilan, provider.gagal, provider.token]),
    ).toEqual([
      ["OR", 2, 0, 158],
      ["Groq", 1, 1, 0],
    ]);
    expect(usage.per_fitur.map((feature: any) => [feature.fitur, feature.panggilan, feature.token])).toEqual([
      ["rekomendasi", 2, 150],
      ["uji", 1, 8],
    ]);
    expect(usage.per_hari).toHaveLength(7);
    expect(usage.per_hari.at(-1)).toEqual({ tanggal: getWibDate(), panggilan: 3, gagal: 1, token: 158 });
    expect(usage.per_hari.slice(0, 6).every((day: any) => day.panggilan === 0)).toBe(true);
    expect(usage.gagal_terakhir).toMatchObject([
      { label: "Groq", fitur: "rekomendasi", error: "Kuota/batas pemakaian habis (429)." },
    ]);
    expect((await pakai("?days=abc").expect(200)).body.data.per_hari).toHaveLength(7);
    expect((await pakai("?days=30").expect(200)).body.data.per_hari).toHaveLength(30);
    await pakai("", setup.tokenA).expect(403);
  });

  test("Gemini: token dari usageMetadata", async () => {
    await db.query("DELETE FROM ai_usage");
    const id = (
      await tambah({ provider: "gemini", label: "Gemini", model: "gemini-2.0-flash", api_key: "AIza-uji-1234567890" })
    ).body.data.id;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: "Hai" }] } }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
          }),
        ),
      ),
    );
    expect(await ai.ask("s", "p", { feature: "asisten", userId: 7 })).toBe("Hai");
    const [[row]] = await db.query<any[]>(
      "SELECT provider_id, provider, label, prompt_tokens, completion_tokens, total_tokens FROM ai_usage",
    );
    expect(row).toEqual({
      provider_id: id,
      provider: "gemini",
      label: "Gemini",
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
  });

  test("pembersihan: riwayat pemakaian > 90 hari dihapus", async () => {
    await db.query("DELETE FROM ai_usage");
    for (const [label, hari] of [
      ["lama", 91],
      ["baru", 89],
    ] as const) {
      await db.query(
        "INSERT INTO ai_usage (provider, label, model, fitur, ok, latency_ms, created_at) VALUES ('groq', ?, 'm', 'asisten', TRUE, 1, UTC_TIMESTAMP() - INTERVAL ? DAY)",
        [label, hari],
      );
    }
    await cleanupServerLogs();
    expect((await db.query<any[]>("SELECT label FROM ai_usage"))[0]).toEqual([{ label: "baru" }]);
  });
});
