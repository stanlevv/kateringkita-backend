import { randomUUID } from "node:crypto";
import request from "supertest";
import { beforeEach, expect, test } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { hariIniWib } from "../src/merchant/kuota";
import { pembeliBaru, siapCheckout } from "./helpers/toko";

// F06 Task 6: GET /orders/:code/whatsapp (C-13, D15)
let s: Awaited<ReturnType<typeof siapCheckout>>;

const pesan = async (o: Record<string, unknown> = {}) => {
  const r = await request(app).post("/api/v1/orders").set("Authorization", `Bearer ${s.tCust}`).set("Idempotency-Key", randomUUID())
    .send({
      items: [{ menu_id: s.menu, qty: 2, option_ids: [s.keju] }, { menu_id: s.menu2, qty: 1 }], pickup_point_id: 1, payment_method: "cod", ...o,
    }).expect(201);
  return r.body.data.code as string;
};
const wa = (code: string, token = s.tCust) => request(app).get(`/api/v1/orders/${code}/whatsapp`).set("Authorization", `Bearer ${token}`);
const teks = (url: string) => decodeURIComponent(url.split("text=")[1]);

beforeEach(async () => {
  s = await siapCheckout();
});

test("pesan tetap bersuara pembeli, tautan wa.me 62…", async () => {
  const code = await pesan({ note: "Pedas" });
  const r = await wa(code).expect(200);
  const d = r.body.data;
  expect(Object.keys(d).sort()).toEqual(["message", "url", "wa_number"]);
  expect(d.wa_number).toBe("081298765432");
  expect(d.url.startsWith("https://wa.me/6281298765432?text=")).toBe(true);
  expect(teks(d.url)).toBe(d.message);
  expect(d.message).toBe(
    `Halo Dapur Siti, saya Budi memesan lewat KateringKita.\n\nKode: ${code}\nMenu: 2x Nasi Ayam, 1x Es Teh\nTotal: Rp 41.000\n`
    + "Cara bayar: Tunai\nAmbil di: Gedung Vokasi UB (Lt. 2)\nWaktu ambil: Secepatnya\nCatatan: Pedas",
  );
});

test("tanpa catatan → tanpa baris Catatan; pickup_at 13:30 WIB → 13.30 WIB; templat toko tidak dipakai", async () => {
  await db.query("UPDATE merchants SET wa_template = 'Halo {nama}, pesanan {kode} diterima.' WHERE id = ?", [s.idA]);
  const code = await pesan({ pickup_at: `${hariIniWib()}T13:30:00+07:00` });
  const { message } = (await wa(code).expect(200)).body.data;
  expect(message).not.toContain("Catatan");
  expect(message).toContain("Waktu ambil: 13.30 WIB");
  expect(message.startsWith("Halo Dapur Siti, saya Budi memesan lewat KateringKita.")).toBe(true);
});

test("karakter khusus di catatan ter-encode", async () => {
  const code = await pesan({ note: "A & B #1\nbaris dua" });
  const { url, message } = (await wa(code).expect(200)).body.data;
  const q = url.split("text=")[1];
  expect(q).not.toMatch(/[&#\n ]/);
  expect(teks(url)).toBe(message);
  expect(message).toContain("Catatan: A & B #1\nbaris dua");
});

test("nomor WA 628… / +628… dinormalkan ke 628…", async () => {
  const code = await pesan();
  for (const nomor of ["6281298765432", "+6281298765432", "081298765432"]) {
    await db.query("UPDATE merchants SET wa_number = ? WHERE id = ?", [nomor, s.idA]);
    const { url } = (await wa(code).expect(200)).body.data;
    expect(url.startsWith("https://wa.me/6281298765432?text=")).toBe(true);
  }
});

test("ambil bukan hari ini → tanggal ikut ditulis", async () => {
  const lusa = new Date(Date.parse(`${hariIniWib()}T10:00:00+07:00`) + 2 * 86400e3);
  const code = await pesan({ pickup_at: lusa.toISOString() });
  const { message } = (await wa(code).expect(200)).body.data;
  const tgl = new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", day: "numeric", month: "long" }).format(lusa);
  expect(message).toContain(`Waktu ambil: ${tgl} 10.00 WIB`);
});

test("pembeli lain 404, penjual 403", async () => {
  const code = await pesan();
  const r = await wa(code, await pembeliBaru(1)).expect(404);
  expect(r.body.error.message).toBe("Pesanan tidak ditemukan.");
  await wa(code, s.tA).expect(403);
});
