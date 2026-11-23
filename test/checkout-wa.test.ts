import { randomUUID } from "node:crypto";
import request from "supertest";
import { beforeEach, expect, test } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { getWibDate } from "../src/services/merchant-quota.service";
import { createCustomer, prepareCheckout } from "./helpers/merchant";

// GET /orders/:code/whatsapp: tautan WhatsApp pembeli ke toko
let setup: Awaited<ReturnType<typeof prepareCheckout>>;

const postOrder = async (overrides: Record<string, unknown> = {}) => {
  const res = await request(app)
    .post("/api/v1/orders")
    .set("Authorization", `Bearer ${setup.customerToken}`)
    .set("Idempotency-Key", randomUUID())
    .send({
      items: [
        { menu_id: setup.menu, qty: 2, option_ids: [setup.keju] },
        { menu_id: setup.menu2, qty: 1 },
      ],
      pickup_point_id: 1,
      payment_method: "cod",
      ...overrides,
    })
    .expect(201);
  return res.body.data.code as string;
};
const getWhatsapp = (code: string, token = setup.customerToken) =>
  request(app).get(`/api/v1/orders/${code}/whatsapp`).set("Authorization", `Bearer ${token}`);
const decodeText = (url: string) => decodeURIComponent(url.split("text=")[1]);

beforeEach(async () => {
  setup = await prepareCheckout();
});

test("pesan tetap bersuara pembeli, tautan wa.me 62…", async () => {
  const code = await postOrder({ note: "Pedas" });
  const res = await getWhatsapp(code).expect(200);
  const data = res.body.data;
  expect(Object.keys(data).sort()).toEqual(["message", "url", "wa_number"]);
  expect(data.wa_number).toBe("081298765432");
  expect(data.url.startsWith("https://wa.me/6281298765432?text=")).toBe(true);
  expect(decodeText(data.url)).toBe(data.message);
  expect(data.message).toBe(
    `Halo Dapur Siti, saya Budi memesan lewat KateringKita.\n\nKode: ${code}\nMenu: 2x Nasi Ayam, 1x Es Teh\nTotal: Rp 41.000\n` +
      "Cara bayar: Tunai\nAmbil di: Gedung Vokasi UB (Lt. 2)\nWaktu ambil: Secepatnya\nCatatan: Pedas",
  );
});

test("tanpa catatan → tanpa baris Catatan; pickup_at 13:30 WIB → 13.30 WIB; templat toko tidak dipakai", async () => {
  await db.query("UPDATE merchants SET wa_template = 'Halo {nama}, pesanan {kode} diterima.' WHERE id = ?", [
    setup.idA,
  ]);
  const code = await postOrder({ pickup_at: `${getWibDate()}T13:30:00+07:00` });
  const { message } = (await getWhatsapp(code).expect(200)).body.data;
  expect(message).not.toContain("Catatan");
  expect(message).toContain("Waktu ambil: 13.30 WIB");
  expect(message.startsWith("Halo Dapur Siti, saya Budi memesan lewat KateringKita.")).toBe(true);
});

test("karakter khusus di catatan ter-encode", async () => {
  const code = await postOrder({ note: "A & B #1\nbaris dua" });
  const { url, message } = (await getWhatsapp(code).expect(200)).body.data;
  const encodedText = url.split("text=")[1];
  expect(encodedText).not.toMatch(/[&#\n ]/);
  expect(decodeText(url)).toBe(message);
  expect(message).toContain("Catatan: A & B #1\nbaris dua");
});

test("nomor WA 628… / +628… dinormalkan ke 628…", async () => {
  const code = await postOrder();
  for (const phone of ["6281298765432", "+6281298765432", "081298765432"]) {
    await db.query("UPDATE merchants SET wa_number = ? WHERE id = ?", [phone, setup.idA]);
    const { url } = (await getWhatsapp(code).expect(200)).body.data;
    expect(url.startsWith("https://wa.me/6281298765432?text=")).toBe(true);
  }
});

test("ambil bukan hari ini → tanggal ikut ditulis", async () => {
  const dayAfterTomorrow = new Date(Date.parse(`${getWibDate()}T10:00:00+07:00`) + 2 * 86400e3);
  const code = await postOrder({ pickup_at: dayAfterTomorrow.toISOString() });
  const { message } = (await getWhatsapp(code).expect(200)).body.data;
  const dateLabel = new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "numeric",
    month: "long",
  }).format(dayAfterTomorrow);
  expect(message).toContain(`Waktu ambil: ${dateLabel} 10.00 WIB`);
});

test("pembeli lain 404, penjual 403", async () => {
  const code = await postOrder();
  const res = await getWhatsapp(code, await createCustomer(1)).expect(404);
  expect(res.body.error.message).toBe("Pesanan tidak ditemukan.");
  await getWhatsapp(code, setup.tokenA).expect(403);
});
