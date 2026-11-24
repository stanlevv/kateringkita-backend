import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { env } from "../src/config/env";
import { tableOrderLimiter } from "../src/middleware/rate-limiter";
import { sendNotification } from "./helpers/midtrans";
import { menuRow, prepareCheckout, insertMenu } from "./helpers/merchant";

// Pesan dari meja (QR): penjual kelola meja, tamu tanpa login lihat menu → pesan → bayar Snap (di-stub) → notifikasi → status
let setup: Awaited<ReturnType<typeof prepareCheckout>>;
let token = "";
const KEY = "SB-Mid-server-uji";
const SNAP = "https://app.sandbox.midtrans.com/snap/v4/redirection/uji";
const RETURN_URL = "http://localhost:3000/meja/pesanan/x";

const merchantRequest = (path: string, token = setup.tokenA) => ({
  get: () => request(app).get(`/api/v1/merchant${path}`).set("Authorization", `Bearer ${token}`),
  post: (body: unknown) =>
    request(app)
      .post(`/api/v1/merchant${path}`)
      .set("Authorization", `Bearer ${token}`)
      .send(body as object),
  patch: (body: unknown) =>
    request(app)
      .patch(`/api/v1/merchant${path}`)
      .set("Authorization", `Bearer ${token}`)
      .send(body as object),
});
const postOrder = (body: Record<string, unknown> = {}, tableToken = token) =>
  request(app)
    .post(`/api/v1/tables/${tableToken}/orders`)
    .send({ items: [{ menu_id: setup.menu, qty: 2, option_ids: [setup.keju] }], customer_name: "Andi", ...body });
const status = (code: string, guestToken: string) =>
  request(app).get(`/api/v1/guest/orders/${code}`).set("X-Guest-Token", guestToken);
const pay = (code: string, guestToken: string, returnUrl = RETURN_URL) =>
  request(app).post(`/api/v1/guest/orders/${code}/pay`).set("X-Guest-Token", guestToken).send({ kembali: returnUrl });
const postNotification = (fields: Record<string, string>) =>
  sendNotification(
    {
      status_code: "200",
      transaction_status: "settlement",
      payment_type: "qris",
      transaction_id: "trx-meja",
      ...fields,
    },
    KEY,
  );
const orderRow = async (code: string) =>
  ((await db.query<any[]>("SELECT * FROM orders WHERE code = ?", [code]))[0] as any[])[0];

beforeAll(async () => {
  setup = await prepareCheckout();
  env.MIDTRANS_SERVER_KEY = undefined;
  env.MIDTRANS_IS_PRODUCTION = "false";
  await merchantRequest("/profile").patch({ dine_in_enabled: true }).expect(200);
  token = (await merchantRequest("/tables").post({ label: "1" }).expect(201)).body.data.token;
});
afterEach(async () => {
  env.MIDTRANS_SERVER_KEY = undefined;
  vi.unstubAllGlobals();
  tableOrderLimiter.reset();
  await db.query("UPDATE orders SET status = 'expired' WHERE status = 'holding'");
  await db.query("UPDATE menus SET held_today = 0");
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("penjual mengelola meja", () => {
  test("sakelar dine-in di profil; meja baru bertoken QR; nama ganda 409; ganti token mematikan QR lama; toko lain 404", async () => {
    expect((await merchantRequest("/profile").get().expect(200)).body.data.dine_in_enabled).toBe(true);
    const res = await merchantRequest("/tables").post({ label: "  2 " }).expect(201);
    expect(res.body.data).toMatchObject({ label: "2", is_active: true });
    expect(res.body.data.token).toMatch(/^[0-9a-f]{32}$/);
    expect((await merchantRequest("/tables").post({ label: "2" }).expect(409)).body.error.fields.label).toEqual([
      "Nama meja sudah dipakai.",
    ]);
    const oldToken = res.body.data.token;
    const newToken = (await merchantRequest(`/tables/${res.body.data.id}`).patch({ ganti_token: true }).expect(200))
      .body.data.token;
    expect(newToken).not.toBe(oldToken);
    await request(app).get(`/api/v1/tables/${oldToken}`).expect(404);
    await request(app).get(`/api/v1/tables/${newToken}`).expect(200);
    await merchantRequest(`/tables/${res.body.data.id}`, setup.tokenB).patch({ is_active: false }).expect(404);
    expect(
      (await merchantRequest("/tables").get().expect(200)).body.data.map((table: { label: string }) => table.label),
    ).toEqual(["1", "2"]);
  });
});

describe("menu meja (tanpa login)", () => {
  test("menu toko + opsi aktif, tanpa pre-order; meja nonaktif / dine-in mati / token asal → 404", async () => {
    const preorderMenu = await insertMenu(setup.idA, { name: "Tumpeng", is_preorder: true, preorder_days: 2 });
    const res = await request(app).get(`/api/v1/tables/${token}`).expect(200);
    expect(res.body.data.table).toEqual({ label: "1" });
    expect(res.body.data.merchant).toMatchObject({ business_name: "Dapur Siti", is_open: true });
    const chickenMenu = res.body.data.menus.find((menu: { id: number }) => menu.id === setup.menu);
    expect(chickenMenu.options).toEqual([{ id: setup.keju, name: "Keju", extra_price: 3000 }]);
    expect(res.body.data.menus.map((menu: { id: number }) => menu.id)).not.toContain(preorderMenu);
    await db.query("UPDATE menus SET is_active = FALSE WHERE id = ?", [preorderMenu]);
    await request(app).get("/api/v1/tables/bukan-token").expect(404);
    await merchantRequest("/profile").patch({ dine_in_enabled: false }).expect(200);
    await request(app).get(`/api/v1/tables/${token}`).expect(404);
    await merchantRequest("/profile").patch({ dine_in_enabled: true }).expect(200);
  });
});

describe("pesanan tamu", () => {
  // Batas token meja: token bukan 32-hex (mis. 4096 karakter) ditolak sebelum masuk Map limiter
  test("token meja berformat salah → 404 tanpa menambah isi limiter", async () => {
    const res = await request(app)
      .post(`/api/v1/tables/${"a".repeat(4096)}/orders`)
      .send({})
      .expect(404);
    expect(res.body.error.message).toBe("Meja tidak ditemukan atau tidak aktif.");
    expect(tableOrderLimiter.size()).toBe(0);
  });

  test("holding tanpa akun & titik temu, stok ditahan; status lewat token tamu; penjual melihat meja", async () => {
    const res = await postOrder().expect(201);
    const { code, guest_token: guestToken } = res.body.data;
    expect(res.body.data).toMatchObject({
      status: "holding",
      payment_status: "unpaid",
      table: { label: "1" },
      customer_name: "Andi",
      total: 36000,
      payment_url: null,
    });
    expect(await orderRow(code)).toMatchObject({ customer_id: null, pickup_point_id: null, payment_method: "online" });
    expect((await menuRow(setup.menu)).held_today).toBe(2);
    expect((await status(code, guestToken).expect(200)).body.data.code).toBe(code);
    await status(code, "salah").expect(404);
    const detail = (await merchantRequest(`/orders/${code}`).get().expect(200)).body.data;
    expect(detail).toMatchObject({
      table: { label: "1" },
      pickup_point: null,
      customer_name: "Andi",
      payment_method: "online",
    });
    expect((await postOrder({ items: [{ menu_id: setup.menu, qty: 99 }] }).expect(409)).body.error.code).toBe(
      "OUT_OF_STOCK",
    );
  });

  test("bayar Snap (kembali harus web sendiri, idempoten) → settlement → confirmed & lunas", async () => {
    env.MIDTRANS_SERVER_KEY = KEY;
    const { code, guest_token: guestToken, total } = (await postOrder().expect(201)).body.data;
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ token: "snap-uji", redirect_url: SNAP })));
    vi.stubGlobal("fetch", fetch);
    await pay(code, guestToken, "https://jahat.example/curi").expect(400);
    expect((await pay(code, guestToken).expect(200)).body.data.payment_url).toBe(SNAP);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://app.sandbox.midtrans.com/snap/v1/transactions");
    expect(JSON.parse(init.body)).toMatchObject({
      transaction_details: { order_id: code, gross_amount: total },
      callbacks: { finish: RETURN_URL },
    });
    expect((await pay(code, guestToken).expect(200)).body.data.payment_url).toBe(SNAP);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await status(code, guestToken)).body.data).toMatchObject({ payment_status: "pending", payment_url: SNAP });
    await postNotification({ order_id: code, gross_amount: `${total}.00` }).expect(200);
    expect(await orderRow(code)).toMatchObject({ status: "confirmed", payment_status: "paid" });
    const [payment] = (
      await db.query<any[]>("SELECT p.* FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.code = ?", [code])
    )[0] as any[];
    expect(payment).toMatchObject({ method: "online", status: "paid", provider_ref: "trx-meja" });
    expect((await status(code, guestToken)).body.data).toMatchObject({ status: "confirmed", payment_url: null });
  });

  test("maksimal 5 pesanan menunggu per meja", async () => {
    for (let i = 0; i < 5; i++) await postOrder({ items: [{ menu_id: setup.menu2, qty: 1 }] }).expect(201);
    expect((await postOrder({ items: [{ menu_id: setup.menu2, qty: 1 }] }).expect(409)).body.error.message).toMatch(
      /menunggu pembayaran/,
    );
  });

  // Batas stok tamu: tamu anonim tanpa bayar dulu tidak boleh menahan seluruh sisa stok lewat satu meja
  test("maksimal 30 porsi menunggu per meja", async () => {
    const bigMenu = await insertMenu(setup.idA, { name: "Nasi Kotak", daily_quota: 100, quota_today: 100 });
    await postOrder({ items: [{ menu_id: bigMenu, qty: 25 }] }).expect(201);
    expect((await postOrder({ items: [{ menu_id: bigMenu, qty: 6 }] }).expect(409)).body.error.message).toBe(
      "Maksimal 30 porsi menunggu pembayaran per meja. Selesaikan pembayaran pesanan lain dulu.",
    );
    await postOrder({ items: [{ menu_id: bigMenu, qty: 5 }] }).expect(201); // tepat 30 masih boleh
  });
});
