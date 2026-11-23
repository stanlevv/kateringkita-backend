import request from "supertest";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { createAdmin } from "../src/scripts/create-admin";
import { login, menuRow, placeOrder, prepareCheckout } from "./helpers/merchant";

// moderasi ulasan & menu oleh admin
let setup: Awaited<ReturnType<typeof prepareCheckout>>;
let adminToken: string;
let reviewId: number;
const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });
const adminRequest = (method: "get" | "post", path: string, body?: object) => {
  const req = request(app)[method](`/api/v1/admin${path}`).set(authHeader(adminToken));
  return body ? req.send(body) : req;
};
const logs = async (action: string) =>
  ((await db.query<any[]>("SELECT * FROM admin_audit_logs WHERE action = ?", [action]))[0] as any[]).length;

beforeAll(async () => {
  setup = await prepareCheckout();
  await createAdmin({ phone: "081300000009", fullName: "Admin Uji", password: "rahasia123" });
  adminToken = await login("081300000009");
  const code = await placeOrder(setup.customerToken, setup.menu);
  for (const action of ["confirm", "cook", "ready", "complete"])
    await request(app).post(`/api/v1/merchant/orders/${code}/${action}`).set(authHeader(setup.tokenA)).expect(200);
  await request(app)
    .post(`/api/v1/orders/${code}/reviews`)
    .set(authHeader(setup.customerToken))
    .send({ items: [{ menu_id: setup.menu, rating: 1, comment: "Spam promo judi" }] })
    .expect(201);
  reviewId = ((await db.query<any[]>("SELECT id FROM reviews"))[0] as any[])[0].id;
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("ulasan", () => {
  test("daftar + filter; hanya admin", async () => {
    const res = await adminRequest("get", "/reviews?q=judi").expect(200);
    expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 1 });
    expect(res.body.data[0]).toMatchObject({
      id: reviewId,
      hidden: false,
      menu: { id: setup.menu, name: "Nasi Ayam" },
      merchant: { business_name: "Dapur Siti" },
      customer_name: "Budi",
    });
    expect((await adminRequest("get", "/reviews?status=moderated").expect(200)).body.data).toEqual([]);
    await adminRequest("get", "/reviews?status=x").expect(400);
    await request(app).get("/api/v1/admin/reviews").set(authHeader(setup.tokenA)).expect(403);
  });

  test("hide wajib alasan; rating & daftar publik/toko mengabaikan; idempoten; unhide memulihkan", async () => {
    await adminRequest("post", `/reviews/${reviewId}/hide`, {}).expect(400);
    const res = await adminRequest("post", `/reviews/${reviewId}/hide`, { reason: "Spam" }).expect(200);
    expect(res.body.data).toMatchObject({ hidden: true, hidden_reason: "Spam" });
    expect(await menuRow(setup.menu)).toMatchObject({ rating_avg: "0.00", rating_count: 0 });
    expect((await request(app).get(`/api/v1/menus/${setup.menu}/reviews`).expect(200)).body.meta.total).toBe(0);
    expect(
      (await request(app).get("/api/v1/merchant/reviews").set(authHeader(setup.tokenA)).expect(200)).body.data,
    ).toEqual([]);
    await adminRequest("post", `/reviews/${reviewId}/hide`, { reason: "Lagi" }).expect(200);
    expect(await logs("review.hide")).toBe(1);

    expect((await adminRequest("post", `/reviews/${reviewId}/unhide`).expect(200)).body.data).toMatchObject({
      hidden: false,
      hidden_reason: null,
    });
    expect(await menuRow(setup.menu)).toMatchObject({ rating_avg: "1.00", rating_count: 1 });
    expect(await logs("review.unhide")).toBe(1);
    await adminRequest("post", "/reviews/999999/hide", { reason: "x" }).expect(404);
  });
});

describe("menu", () => {
  test("takedown: nonaktif, hilang dari katalog, penjual tidak bisa mengaktifkan; restore: penjual boleh lagi", async () => {
    const res = await adminRequest("post", `/menus/${setup.menu2}/takedown`, { reason: "Foto melanggar" }).expect(200);
    expect(res.body.data).toMatchObject({
      id: setup.menu2,
      is_active: false,
      moderated: true,
      moderation_reason: "Foto melanggar",
      merchant: { id: setup.idA },
    });
    expect(await logs("menu.takedown")).toBe(1);
    await request(app).get(`/api/v1/menus/${setup.menu2}`).expect(404);
    const activate = () =>
      request(app)
        .patch(`/api/v1/merchant/menus/${setup.menu2}`)
        .set(authHeader(setup.tokenA))
        .send({ is_active: true });
    expect((await activate().expect(409)).body.error.message).toBe(
      "Menu ini diturunkan admin: Foto melanggar. Hubungi admin untuk memulihkan.",
    );
    expect(
      (await adminRequest("get", "/menus?status=moderated").expect(200)).body.data.map(
        (menu: { id: number }) => menu.id,
      ),
    ).toEqual([setup.menu2]);

    expect((await adminRequest("post", `/menus/${setup.menu2}/restore`).expect(200)).body.data).toMatchObject({
      moderated: false,
      is_active: false,
    });
    await activate().expect(200);
    expect(await logs("menu.restore")).toBe(1);
  });

  test("daftar menu admin memuat foto tambahan (gallery) agar ikut dimoderasi; tanpa foto tambahan → []", async () => {
    const gallery = ["https://foto.test/merchants/1/menu/a.jpg", "https://foto.test/merchants/1/menu/b.jpg"];
    await db.query("UPDATE menus SET gallery = ? WHERE id = ?", [JSON.stringify(gallery), setup.menu]);
    const rows: { id: number; gallery: string[] }[] = (await adminRequest("get", "/menus").expect(200)).body.data;
    expect(rows.find((menu) => menu.id === setup.menu)!.gallery).toEqual(gallery);
    expect(rows.find((menu) => menu.id === setup.menu2)!.gallery).toEqual([]);
  });

  test("hapus satu foto: foto tambahan dikeluarkan; foto utama diganti foto tambahan pertama; tercatat di audit; menu tetap dijual", async () => {
    const [mainPhoto, extraOne, extraTwo] = ["u", "a", "b"].map(
      (suffix) => `https://foto.test/merchants/${setup.idA}/menu/${suffix}.jpg`,
    );
    await db.query("UPDATE menus SET image_url = ?, gallery = ?, is_active = TRUE WHERE id = ?", [
      mainPhoto,
      JSON.stringify([extraOne, extraTwo]),
      setup.menu,
    ]);
    const removePhoto = (url: string, reason = "Foto tidak sesuai") =>
      adminRequest("post", `/menus/${setup.menu}/photos/remove`, { url, reason });

    const afterExtra = (await removePhoto(extraOne).expect(200)).body.data;
    expect(afterExtra).toMatchObject({
      id: setup.menu,
      image_url: mainPhoto,
      gallery: [extraTwo],
      is_active: true,
      moderated: false,
    });
    const afterMain = (await removePhoto(mainPhoto, "Foto bukan makanan").expect(200)).body.data;
    expect(afterMain).toMatchObject({ image_url: extraTwo, gallery: [] });
    expect((await removePhoto(extraTwo).expect(200)).body.data).toMatchObject({ image_url: null, gallery: [] });

    const [log] = await db.query<any[]>(
      "SELECT reason, before_json, after_json FROM admin_audit_logs WHERE action = 'menu.photo_remove' ORDER BY id",
    );
    expect(log.length).toBe(3);
    expect(log[1].reason).toBe("Foto bukan makanan");
    const json = (value: unknown) => (typeof value === "string" ? JSON.parse(value) : value);
    expect(json(log[1].before_json)).toEqual({ image_url: mainPhoto, gallery: [extraTwo] });
    expect(json(log[1].after_json)).toEqual({ image_url: extraTwo, gallery: [] });
  });

  test("hapus foto → notifikasi ke penjual pemilik menu (nama menu + alasan), terlihat di GET /me/notifications", async () => {
    const photo = `https://foto.test/merchants/${setup.idA}/menu/n.jpg`;
    await db.query("UPDATE menus SET gallery = ? WHERE id = ?", [JSON.stringify([photo]), setup.menu]);
    await adminRequest("post", `/menus/${setup.menu}/photos/remove`, { url: photo, reason: "Foto buram" }).expect(200);
    const body = (
      await request(app).get("/api/v1/me/notifications?type=moderation").set(authHeader(setup.tokenA)).expect(200)
    ).body;
    expect(body.data[0]).toMatchObject({ type: "moderation", title: "Foto menu dihapus admin" });
    expect(body.data[0].body).toContain("Foto buram");
    expect(body.data[0].body).toContain(String(((await menuRow(setup.menu)) as { name: string }).name));
    expect(body.meta.unread_count).toBeGreaterThan(0);
    // penjual lain tidak menerima
    expect(
      (await request(app).get("/api/v1/me/notifications?type=moderation").set(authHeader(setup.tokenB)).expect(200))
        .body.data,
    ).toEqual([]);
  });

  test("hapus foto: URL bukan milik menu → 404; alasan kosong → 400; menu tidak ada → 404", async () => {
    const otherPhoto = `https://foto.test/merchants/${setup.idA}/menu/lain.jpg`;
    expect(
      (await adminRequest("post", `/menus/${setup.menu2}/photos/remove`, { url: otherPhoto, reason: "x" }).expect(404))
        .body.error.message,
    ).toBe("Foto tidak ditemukan di menu ini.");
    expect(
      (await adminRequest("post", `/menus/${setup.menu2}/photos/remove`, { url: otherPhoto }).expect(400)).body.error
        .fields.reason,
    ).toBeDefined();
    expect(
      (await adminRequest("post", `/menus/${setup.menu2}/photos/remove`, { reason: "x" }).expect(400)).body.error.fields
        .url,
    ).toBeDefined();
    await adminRequest("post", "/menus/999999/photos/remove", { url: otherPhoto, reason: "x" }).expect(404);
  });
});
