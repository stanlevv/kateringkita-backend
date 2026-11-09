import request from "supertest";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { env } from "../src/config/env";
import { createAdmin } from "../src/scripts/create-admin";
import { ai } from "../src/services/ai.service";
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
    expect(await ai.tanya("sistem", "pesan")).toBe("Halo dari OR");
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([URL_GROQ, URL_OR]);
    const init = fetch.mock.calls[1][1] as unknown as RequestInit & { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe("Bearer sk-or-12345678");
    expect(JSON.parse(init.body as string)).toMatchObject({ model: "meta/llama:free", messages: [{ role: "system", content: "sistem" }, { role: "user", content: "pesan" }] });
    const g = await baris(groq);
    expect(g.last_error).toBe("Kuota/batas pemakaian habis (429).");
    expect(Number(g.sisa)).toBeGreaterThan(100);
    expect((await baris(or)).last_ok_at).not.toBeNull();
    fetch.mockClear();
    expect(await ai.tanya("s", "p")).toBe("Halo dari OR");
    expect(fetch).toHaveBeenCalledTimes(1);
    // asisten penjual memakai gateway yang sama
    expect((await request(app).post("/api/v1/merchant/assistant").set("Authorization", `Bearer ${s.tA}`).send({ question: "halo" }).expect(200)).body.data.answer).toBe("Halo dari OR");
  });

  test("tanpa penyedia → 503; nonaktif dilewati; GEMINI_API_KEY env cadangan terakhir; semua gagal → 502", async () => {
    await expect(ai.tanya("s", "p")).rejects.toMatchObject({ status: 503 });
    await tambah({ priority: 1, is_active: false });
    await tambah({ provider: "nvidia", label: "NIM", model: "meta/llama-3.3-70b-instruct", api_key: "nvapi-1234567890", priority: 2 });
    env.GEMINI_API_KEY = "kunci-env";
    const fetch = vi.fn(async (url: string) => (url === URL_NIM
      ? new Response("{}", { status: 500 })
      : new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Halo env" }] } }] }))));
    vi.stubGlobal("fetch", fetch);
    expect(await ai.tanya("s", "p")).toBe("Halo env");
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([URL_NIM, `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent`]);
    fetch.mockImplementation(async () => new Response("{}", { status: 500 }));
    await expect(ai.tanya("s", "p")).rejects.toMatchObject({ status: 502 });
  });
});
