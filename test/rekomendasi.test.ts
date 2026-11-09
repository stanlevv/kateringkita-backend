import request from "supertest";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import { asistenLimiter } from "../src/middleware/rateLimiter";
import { ai } from "../src/services/ai.service";
import { kataKunci } from "../src/services/rekomendasi.service";
import { AppError } from "../src/utils/errors";
import { BOCOR, bekukanJam, siapkanToko, sisipMenu, tampilkan } from "./helpers/toko";

// F24: POST /assistant/recommendations — kandidat dari DB, AI memilih, backend memvalidasi ulang
let s: Awaited<ReturnType<typeof siapkanToko>>;
let spesial: number, geprek: number, esTeh: number, kampung: number, habis: number, mati: number, minimal: number;
const minta = (body: Record<string, unknown>, t: string | null = s.tCust) => {
  const r = request(app).post("/api/v1/assistant/recommendations");
  return (t ? r.set("Authorization", `Bearer ${t}`) : r).send(body);
};
const jawab = (teks: string) => vi.spyOn(ai, "tanya").mockResolvedValue(teks);

beforeAll(async () => {
  bekukanJam();
  s = await siapkanToko();
  await tampilkan(s.idA);
  await tampilkan(s.idB);
  spesial = await sisipMenu(s.idA, { name: "Nasi Goreng Spesial", description: "Nasi goreng telur mata sapi", sold_total: 10 });
  geprek = await sisipMenu(s.idA, { name: "Ayam Geprek", category_id: 2, price: 18000, description: "Sambal level pedas", sold_total: 50 });
  esTeh = await sisipMenu(s.idA, { name: "Es Teh", category_id: 5, price: 5000, hpp: 2000, sold_total: 30 });
  kampung = await sisipMenu(s.idB, { name: "Nasi Goreng Kampung", price: 12000, quota_today: 3, daily_quota: 3, sold_total: 1 });
  habis = await sisipMenu(s.idA, { name: "Soto Habis", quota_today: 5, sold_today: 5 });
  mati = await sisipMenu(s.idA, { name: "Menu Nonaktif", is_active: false });
  minimal = await sisipMenu(s.idB, { name: "Tumpeng Mini", category_id: 6, price: 20000, min_order_qty: 10, sold_total: 0 });
});
beforeEach(() => {
  bekukanJam();
  asistenLimiter.reset();
});
afterEach(() => vi.restoreAllMocks());

describe("rekomendasi AI pembeli", () => {
  test("AI memilih: hanya id kandidat, qty dijepit stok/min, harga dari DB, dikelompokkan per toko", async () => {
    const spy = jawab("```json\n" + JSON.stringify({
      summary: "Paket nasi goreng untuk 4 orang.",
      items: [
        { id: spesial, qty: 4, reason: "Favorit, tidak pedas" },
        { id: 999999, qty: 1 }, { id: habis, qty: 1 }, { id: mati, qty: 1 }, "rusak", { id: geprek, qty: 0 },
        { id: kampung, qty: 10, reason: "Pilihan hemat" },
        { id: esTeh, qty: "4" },
        { id: spesial, qty: 9 },
        { id: minimal, qty: 2 },
      ],
    }) + "\n```");
    const r = await minta({ question: "  Makan siang 4 orang, tidak pedas  ", portions: 4 }).expect(200);
    const d = r.body.data;
    expect(d.source).toBe("ai");
    expect(d.summary).toBe("Paket nasi goreng untuk 4 orang.");
    expect(d.groups.map((g: any) => [g.merchant.id, g.items.map((i: any) => [i.menu.id, i.qty, i.subtotal]), g.total])).toEqual([
      [s.idA, [[spesial, 4, 60000], [esTeh, 4, 20000]], 80000],
      [s.idB, [[kampung, 3, 36000], [minimal, 10, 200000]], 236000],
    ]);
    expect(d.total).toBe(316000);
    expect(d.groups[0].items[0].reason).toBe("Favorit, tidak pedas");
    expect(d.groups[0].items[0].menu).toMatchObject({ name: "Nasi Goreng Spesial", price: 15000, available: 20, badge: "available" });
    const [, pesan] = spy.mock.calls[0];
    for (const nama of ["Nasi Goreng Spesial", "Ayam Geprek", "Es Teh", "Nasi Goreng Kampung", "Tumpeng Mini"]) expect(pesan).toContain(nama);
    for (const nama of ["Soto Habis", "Menu Nonaktif"]) expect(pesan).not.toContain(nama);
    expect(pesan).toContain("PORSI: 4");
    expect(pesan).toContain("Makan siang 4 orang, tidak pedas");
    const semua = JSON.stringify(r.body) + pesan;
    for (const kunci of BOCOR) expect(semua).not.toContain(kunci);
  });

  test("anggaran: kandidat di atas anggaran tidak dikirim, qty dipotong agar total ≤ anggaran", async () => {
    jawab(JSON.stringify({ summary: "Hemat.", items: [{ id: spesial, qty: 4 }, { id: esTeh, qty: 4 }] }));
    const d = (await minta({ question: "nasi goreng", budget: 50000 }).expect(200)).body.data;
    expect(d.groups[0].items.map((i: any) => [i.menu.id, i.qty])).toEqual([[spesial, 3], [esTeh, 1]]);
    expect(d.total).toBe(50000);
    const spy = jawab(JSON.stringify({ summary: "Hemat.", items: [{ id: esTeh, qty: 1 }] }));
    await minta({ question: "minum", budget: 10000 }).expect(200);
    const pesan = String(spy.mock.calls.at(-1)?.[1]);
    expect(pesan).toContain("ANGGARAN: 10000");
    expect(pesan).toContain("Es Teh");
    for (const nama of ["Nasi Goreng Kampung", "Ayam Geprek", "Tumpeng Mini"]) expect(pesan).not.toContain(nama);
  });

  test("AI tidak aktif/gagal → cadangan: kandidat paling cocok kata kunci, qty = porsi", async () => {
    vi.spyOn(ai, "tanya").mockRejectedValue(new AppError(502, "UPSTREAM_ERROR", "x"));
    const d = (await minta({ question: "nasi goreng buat 5 orang", portions: 5 }).expect(200)).body.data;
    expect(d.source).toBe("fallback");
    expect(d.summary).toMatch(/tidak tersedia/);
    expect(d.groups).toHaveLength(1);
    expect(d.groups[0].items.map((i: any) => [i.menu.id, i.qty, i.subtotal])).toEqual([[spesial, 5, 75000]]);
    // tanpa kata kunci yang cocok → terlaris; min_order_qty tetap dihormati
    expect((await minta({ question: "yang enak dong" }).expect(200)).body.data.groups[0].items[0].menu.id).toBe(geprek);
    expect((await minta({ question: "tumpeng", category: "paket-acara" }).expect(200)).body.data.groups[0].items[0].qty).toBe(10);
  });

  test("AI menolak dengan alasan → dihormati; jawaban rusak → cadangan; tanpa kandidat → AI tidak dipanggil", async () => {
    jawab('{"summary":"Anggaran tidak cukup untuk 50 porsi.","items":[]}');
    expect((await minta({ question: "nasi untuk 50 orang", budget: 20000 }).expect(200)).body.data)
      .toEqual({ source: "ai", summary: "Anggaran tidak cukup untuk 50 porsi.", groups: [], total: 0 });
    jawab("Maaf, saya tidak bisa.");
    const d = (await minta({ question: "nasi goreng" }).expect(200)).body.data;
    expect([d.source, d.summary, d.groups[0].items[0].menu.id]).toEqual(["fallback", "Ini menu paling cocok yang masih tersedia.", spesial]);
    const spy = jawab("{}");
    spy.mockClear();
    const kosong = (await minta({ question: "martabak", category: "martabak" }).expect(200)).body.data;
    expect(kosong).toMatchObject({ source: "fallback", groups: [], total: 0 });
    expect(spy).not.toHaveBeenCalled();
  });

  test("toko tutup tidak jadi kandidat", async () => {
    await tampilkan(s.idB, { buka: false });
    const spy = jawab('{"summary":"x","items":[]}');
    await minta({ question: "nasi goreng" }).expect(200);
    expect(spy.mock.calls[0][1]).not.toContain("Nasi Goreng Kampung");
    await tampilkan(s.idB);
  });

  test("akses & validasi", async () => {
    await minta({ question: "nasi goreng" }, null).expect(401);
    await minta({ question: "nasi goreng" }, s.tA).expect(403);
    expect((await minta({ question: "ab" }).expect(400)).body.error.fields.question).toBeDefined();
    expect((await minta({ question: "nasi", budget: "50000" }).expect(400)).body.error.fields.budget).toBeDefined();
    expect((await minta({ question: "nasi", portions: 0 }).expect(400)).body.error.fields.portions).toBeDefined();
  });
});

test("kataKunci: buang kata umum, angka, dan kata setelah negasi", () => {
  expect(kataKunci("Makan siang 5 orang, TIDAK pedas; nasi-goreng!!")).toEqual(["siang", "nasi", "goreng"]);
  expect(kataKunci("tanpa daging, ayam ayam ok")).toEqual(["ayam"]);
});
