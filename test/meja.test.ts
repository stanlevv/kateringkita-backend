import { createHash } from "node:crypto";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { env } from "../src/config/env";
import { mejaLimiter } from "../src/middleware/rateLimiter";
import { menuRow, siapCheckout, sisipMenu } from "./helpers/toko";

// F21 pesan dari meja: penjual kelola meja, tamu tanpa login lihat menu → pesan → bayar Snap (di-stub) → notifikasi → status
let s: Awaited<ReturnType<typeof siapCheckout>>;
let token = "";
const KEY = "SB-Mid-server-uji";
const SNAP = "https://app.sandbox.midtrans.com/snap/v4/redirection/uji";
const KEMBALI = "http://localhost:3000/meja/pesanan/x";

const toko = (path: string, t = s.tA) => ({
  get: () => request(app).get(`/api/v1/merchant${path}`).set("Authorization", `Bearer ${t}`),
  post: (b: unknown) => request(app).post(`/api/v1/merchant${path}`).set("Authorization", `Bearer ${t}`).send(b as object),
  patch: (b: unknown) => request(app).patch(`/api/v1/merchant${path}`).set("Authorization", `Bearer ${t}`).send(b as object),
});
const pesan = (body: Record<string, unknown> = {}, tk = token) => request(app).post(`/api/v1/tables/${tk}/orders`)
  .send({ items: [{ menu_id: s.menu, qty: 2, option_ids: [s.keju] }], customer_name: "Andi", ...body });
const status = (code: string, tamu: string) => request(app).get(`/api/v1/guest/orders/${code}`).set("X-Guest-Token", tamu);
const bayar = (code: string, tamu: string, kembali = KEMBALI) =>
  request(app).post(`/api/v1/guest/orders/${code}/pay`).set("X-Guest-Token", tamu).send({ kembali });
const notif = (o: Record<string, string>) => {
  const n = { status_code: "200", transaction_status: "settlement", payment_type: "qris", transaction_id: "trx-meja", ...o };
  const signature_key = createHash("sha512").update(`${n.order_id}${n.status_code}${n.gross_amount}${KEY}`).digest("hex");
  return request(app).post("/api/v1/payments/midtrans").send({ ...n, signature_key });
};
const pesanan = async (code: string) => ((await db.query<any[]>("SELECT * FROM orders WHERE code = ?", [code]))[0] as any[])[0];

beforeAll(async () => {
  s = await siapCheckout();
  env.MIDTRANS_SERVER_KEY = undefined;
  env.MIDTRANS_IS_PRODUCTION = "false";
  await toko("/profile").patch({ dine_in_enabled: true }).expect(200);
  token = (await toko("/tables").post({ label: "1" }).expect(201)).body.data.token;
});
afterEach(async () => {
  env.MIDTRANS_SERVER_KEY = undefined;
  vi.unstubAllGlobals();
  mejaLimiter.reset();
  await db.query("UPDATE orders SET status = 'expired' WHERE status = 'holding'");
  await db.query("UPDATE menus SET held_today = 0");
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("penjual mengelola meja", () => {
  test("sakelar dine-in di profil; meja baru bertoken QR; nama ganda 409; ganti token mematikan QR lama; toko lain 404", async () => {
    expect((await toko("/profile").get().expect(200)).body.data.dine_in_enabled).toBe(true);
    const r = await toko("/tables").post({ label: "  2 " }).expect(201);
    expect(r.body.data).toMatchObject({ label: "2", is_active: true });
    expect(r.body.data.token).toMatch(/^[0-9a-f]{32}$/);
    expect((await toko("/tables").post({ label: "2" }).expect(409)).body.error.fields.label).toEqual(["Nama meja sudah dipakai."]);
    const lama = r.body.data.token;
    const baru = (await toko(`/tables/${r.body.data.id}`).patch({ ganti_token: true }).expect(200)).body.data.token;
    expect(baru).not.toBe(lama);
    await request(app).get(`/api/v1/tables/${lama}`).expect(404);
    await request(app).get(`/api/v1/tables/${baru}`).expect(200);
    await toko(`/tables/${r.body.data.id}`, s.tB).patch({ is_active: false }).expect(404);
    expect((await toko("/tables").get().expect(200)).body.data.map((m: { label: string }) => m.label)).toEqual(["1", "2"]);
  });
});

describe("menu meja (tanpa login)", () => {
  test("menu toko + opsi aktif, tanpa pre-order; meja nonaktif / dine-in mati / token asal → 404", async () => {
    const po = await sisipMenu(s.idA, { name: "Tumpeng", is_preorder: true, preorder_days: 2 });
    const r = await request(app).get(`/api/v1/tables/${token}`).expect(200);
    expect(r.body.data.table).toEqual({ label: "1" });
    expect(r.body.data.merchant).toMatchObject({ business_name: "Dapur Siti", is_open: true });
    const ayam = r.body.data.menus.find((m: { id: number }) => m.id === s.menu);
    expect(ayam.options).toEqual([{ id: s.keju, name: "Keju", extra_price: 3000 }]);
    expect(r.body.data.menus.map((m: { id: number }) => m.id)).not.toContain(po);
    await db.query("UPDATE menus SET is_active = FALSE WHERE id = ?", [po]);
    await request(app).get("/api/v1/tables/bukan-token").expect(404);
    await toko("/profile").patch({ dine_in_enabled: false }).expect(200);
    await request(app).get(`/api/v1/tables/${token}`).expect(404);
    await toko("/profile").patch({ dine_in_enabled: true }).expect(200);
  });
});

describe("pesanan tamu", () => {
  test("holding tanpa akun & titik temu, stok ditahan; status lewat token tamu; penjual melihat meja", async () => {
    const r = await pesan().expect(201);
    const { code, guest_token: tamu } = r.body.data;
    expect(r.body.data).toMatchObject({ status: "holding", payment_status: "unpaid", table: { label: "1" }, customer_name: "Andi", total: 36000, payment_url: null });
    expect(await pesanan(code)).toMatchObject({ customer_id: null, pickup_point_id: null, payment_method: "online" });
    expect((await menuRow(s.menu)).held_today).toBe(2);
    expect((await status(code, tamu).expect(200)).body.data.code).toBe(code);
    await status(code, "salah").expect(404);
    const m = (await toko(`/orders/${code}`).get().expect(200)).body.data;
    expect(m).toMatchObject({ table: { label: "1" }, pickup_point: null, customer_name: "Andi", payment_method: "online" });
    expect((await pesan({ items: [{ menu_id: s.menu, qty: 99 }] }).expect(409)).body.error.code).toBe("OUT_OF_STOCK");
  });

  test("bayar Snap (kembali harus web sendiri, idempoten) → settlement → confirmed & lunas", async () => {
    env.MIDTRANS_SERVER_KEY = KEY;
    const { code, guest_token: tamu, total } = (await pesan().expect(201)).body.data;
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ token: "snap-uji", redirect_url: SNAP })));
    vi.stubGlobal("fetch", fetch);
    await bayar(code, tamu, "https://jahat.example/curi").expect(400);
    expect((await bayar(code, tamu).expect(200)).body.data.payment_url).toBe(SNAP);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://app.sandbox.midtrans.com/snap/v1/transactions");
    expect(JSON.parse(init.body)).toMatchObject({ transaction_details: { order_id: code, gross_amount: total }, callbacks: { finish: KEMBALI } });
    expect((await bayar(code, tamu).expect(200)).body.data.payment_url).toBe(SNAP);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await status(code, tamu)).body.data).toMatchObject({ payment_status: "pending", payment_url: SNAP });
    await notif({ order_id: code, gross_amount: `${total}.00` }).expect(200);
    expect(await pesanan(code)).toMatchObject({ status: "confirmed", payment_status: "paid" });
    const [p] = (await db.query<any[]>("SELECT p.* FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.code = ?", [code]))[0] as any[];
    expect(p).toMatchObject({ method: "online", status: "paid", provider_ref: "trx-meja" });
    expect((await status(code, tamu)).body.data).toMatchObject({ status: "confirmed", payment_url: null });
  });

  test("maksimal 5 pesanan menunggu per meja", async () => {
    for (let i = 0; i < 5; i++) await pesan({ items: [{ menu_id: s.menu2, qty: 1 }] }).expect(201);
    expect((await pesan({ items: [{ menu_id: s.menu2, qty: 1 }] }).expect(409)).body.error.message).toMatch(/menunggu pembayaran/);
  });
});
