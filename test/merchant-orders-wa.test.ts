import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { DEFAULT_WA_TEMPLATE } from "../src/services/merchant-order.service";
import { placeOrder, prepareCheckout } from "./helpers/merchant";

// GET /merchant/orders/:code/whatsapp memakai templat toko
let setup: Awaited<ReturnType<typeof prepareCheckout>>;
let code: string;

const getWhatsapp = (orderCode = code, token = setup.tokenA) =>
  request(app).get(`/api/v1/merchant/orders/${orderCode}/whatsapp`).set("Authorization", `Bearer ${token}`);
const decodeText = (url: string) => decodeURIComponent(url.split("?text=")[1]);

beforeAll(async () => {
  setup = await prepareCheckout();
  code = await placeOrder(setup.customerToken, setup.menu, 2);
});
afterAll(() => {
  vi.restoreAllMocks();
});

test("templat bawaan (wa_template NULL) → pesan ke nomor pembeli", async () => {
  const res = await getWhatsapp().expect(200);
  const data = res.body.data;
  expect(Object.keys(data).sort()).toEqual(["message", "url", "wa_number"]);
  expect(data.wa_number).toBe("081234567890");
  expect(data.message.startsWith(`Halo Budi, pesanan ${code} sudah kami terima.`)).toBe(true);
  for (const line of ["Menu: 2x Nasi Ayam", "Total: Rp 30.000", "Cara bayar: Tunai", "Waktu ambil: Secepatnya"])
    expect(data.message).toContain(line);
  expect(data.url.startsWith("https://wa.me/6281234567890?text=")).toBe(true);
  expect(decodeText(data.url)).toBe(data.message);
});

test("templat toko dipakai; placeholder asing dibiarkan; nama dengan & # ter-encode", async () => {
  await db.query("UPDATE merchants SET wa_template = 'Pesanan {kode} siap, {nama}. {asing}' WHERE id = ?", [setup.idA]);
  expect((await getWhatsapp().expect(200)).body.data.message).toBe(`Pesanan ${code} siap, Budi. {asing}`);
  await db.query("UPDATE orders SET customer_name = 'Budi & #1' WHERE code = ?", [code]);
  const data = (await getWhatsapp().expect(200)).body.data;
  expect(data.url).not.toMatch(/[&#] ?1/);
  expect(data.url).toContain("%26");
  expect(decodeText(data.url)).toBe(`Pesanan ${code} siap, Budi & #1. {asing}`);
});

test("DEFAULT_WA_TEMPLATE sama persis dengan fe/lib/wa-template.ts", () => {
  // CI menaruh frontend di fe/; clone lokal bisa memakai frontend/ atau kateringkita-frontend/
  const templatePath = ["fe", "frontend", "kateringkita-frontend"]
    .map((folder) => join(__dirname, "../..", folder, "lib/wa-template.ts"))
    .find((filePath) => existsSync(filePath));
  const feSource = readFileSync(templatePath ?? join(__dirname, "../../fe/lib/wa-template.ts"), "utf8");
  const literal = /export const TEMPLATE_BAWAAN = `([^`]*)`;/.exec(feSource)![1].replace(/\r\n/g, "\n");
  expect(DEFAULT_WA_TEMPLATE).toBe(literal);
});

test("toko lain → 404; pembeli → 403", async () => {
  expect((await getWhatsapp(code, setup.tokenB).expect(404)).body.error.message).toBe("Pesanan tidak ditemukan.");
  await getWhatsapp(code, setup.customerToken).expect(403);
});
