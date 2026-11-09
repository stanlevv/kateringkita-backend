import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import { env } from "../src/config/env";
import { asistenLimiter } from "../src/middleware/rateLimiter";
import { ai } from "../src/services/ai.service";
import { siapkanToko, sisipMenu } from "./helpers/toko";

// F17: POST /merchant/assistant (Gemini) — konteks hanya data toko sendiri
let s: Awaited<ReturnType<typeof siapkanToko>>;
const tanya = (question: unknown, t = s.tA) => request(app).post("/api/v1/merchant/assistant").set("Authorization", `Bearer ${t}`).send({ question });

beforeAll(async () => {
  s = await siapkanToko();
  await sisipMenu(s.idA, { name: "Risol Mayo", price: 5000, hpp: 2500 });
  await sisipMenu(s.idB, { name: "Menu Rahasia Andi", price: 9000, hpp: 7000 });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  asistenLimiter.reset();
  env.GEMINI_API_KEY = undefined;
});
afterAll(() => {
  env.GEMINI_API_KEY = undefined;
});

describe("asisten", () => {
  test("tanpa GEMINI_API_KEY → 503", async () => {
    expect((await tanya("Berapa harga ideal risol?").expect(503)).body.error.message).toBe("Asisten AI belum diaktifkan.");
  });

  test("konteks: menu + HPP toko sendiri, bukan toko lain", async () => {
    env.GEMINI_API_KEY = "kunci-uji";
    const spy = vi.spyOn(ai, "tanya").mockResolvedValue("Naikkan ke Rp 6.000.");
    expect((await tanya("  Berapa harga ideal risol?  ").expect(200)).body).toEqual({ data: { answer: "Naikkan ke Rp 6.000." } });
    const [, pesan] = spy.mock.calls[0];
    expect(pesan).toContain('"nama":"Risol Mayo","harga":5000,"hpp":2500');
    expect(pesan).toContain("Berapa harga ideal risol?");
    expect(pesan).not.toContain("Menu Rahasia Andi");
  });

  test("permintaan ke Gemini REST + jawaban diambil dari candidates; upstream gagal → 502", async () => {
    env.GEMINI_API_KEY = "kunci-uji";
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Halo " }, { text: "toko" }] } }] })));
    vi.stubGlobal("fetch", fetch);
    expect(await ai.tanya("sistem", "pesan")).toBe("Halo toko");
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent`);
    expect(init.headers["x-goog-api-key"]).toBe("kunci-uji");
    expect(JSON.parse(init.body)).toMatchObject({ systemInstruction: { parts: [{ text: "sistem" }] }, contents: [{ role: "user", parts: [{ text: "pesan" }] }] });
    fetch.mockResolvedValue(new Response("{}", { status: 500 }));
    await expect(ai.tanya("s", "p")).rejects.toMatchObject({ status: 502 });
  });

  test("validasi, peran, batas 10 per 10 menit", async () => {
    expect((await tanya("").expect(400)).body.error.fields).toEqual({ question: ["Pertanyaan 1–500 karakter."] });
    await tanya("halo", s.tCust).expect(403);
    env.GEMINI_API_KEY = "kunci-uji";
    vi.spyOn(ai, "tanya").mockResolvedValue("ok");
    for (let i = 0; i < 10; i++) await tanya("halo").expect(200);
    await tanya("halo").expect(429);
  });
});
