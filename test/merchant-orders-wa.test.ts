import { readFileSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { TEMPLAT_BAWAAN } from "../src/merchant/orders";
import { pesanDulu, siapCheckout } from "./helpers/toko";

// F07 Task 5: GET /merchant/orders/:code/whatsapp memakai templat toko (M-04, M-11; D17)
let s: Awaited<ReturnType<typeof siapCheckout>>;
let code: string;

const wa = (c = code, token = s.tA) => request(app).get(`/api/v1/merchant/orders/${c}/whatsapp`).set("Authorization", `Bearer ${token}`);
const teks = (url: string) => decodeURIComponent(url.split("?text=")[1]);

beforeAll(async () => {
  s = await siapCheckout();
  code = await pesanDulu(s.tCust, s.menu, 2);
});
afterAll(() => {
  vi.restoreAllMocks();
});

test("templat bawaan (wa_template NULL) → pesan ke nomor pembeli", async () => {
  const r = await wa().expect(200);
  const d = r.body.data;
  expect(Object.keys(d).sort()).toEqual(["message", "url", "wa_number"]);
  expect(d.wa_number).toBe("081234567890");
  expect(d.message.startsWith(`Halo Budi, pesanan ${code} sudah kami terima.`)).toBe(true);
  for (const s of ["Menu: 2x Nasi Ayam", "Total: Rp 30.000", "Cara bayar: Tunai", "Waktu ambil: Secepatnya"]) expect(d.message).toContain(s);
  expect(d.url.startsWith("https://wa.me/6281234567890?text=")).toBe(true);
  expect(teks(d.url)).toBe(d.message);
});

test("templat toko dipakai; placeholder asing dibiarkan; nama dengan & # ter-encode", async () => {
  await db.query("UPDATE merchants SET wa_template = 'Pesanan {kode} siap, {nama}. {asing}' WHERE id = ?", [s.idA]);
  expect((await wa().expect(200)).body.data.message).toBe(`Pesanan ${code} siap, Budi. {asing}`);
  await db.query("UPDATE orders SET customer_name = 'Budi & #1' WHERE code = ?", [code]);
  const d = (await wa().expect(200)).body.data;
  expect(d.url).not.toMatch(/[&#] ?1/);
  expect(d.url).toContain("%26");
  expect(teks(d.url)).toBe(`Pesanan ${code} siap, Budi & #1. {asing}`);
});

test("TEMPLAT_BAWAAN sama persis dengan fe/lib/wa-template.ts", () => {
  const fe = readFileSync(join(__dirname, "../../fe/lib/wa-template.ts"), "utf8");
  const literal = /export const TEMPLATE_BAWAAN = `([^`]*)`;/.exec(fe)![1].replace(/\r\n/g, "\n");
  expect(TEMPLAT_BAWAAN).toBe(literal);
});

test("toko lain → 404; pembeli → 403", async () => {
  expect((await wa(code, s.tB).expect(404)).body.error.message).toBe("Pesanan tidak ditemukan.");
  await wa(code, s.tCust).expect(403);
});
