import request from "supertest";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { createAdmin } from "../src/scripts/create-admin";
import { login, menuRow, pesanDulu, siapCheckout } from "./helpers/toko";

// F19: moderasi ulasan & menu oleh admin
let s: Awaited<ReturnType<typeof siapCheckout>>;
let tAdmin: string;
let ulasanId: number;
const H = (t: string) => ({ Authorization: `Bearer ${t}` });
const adm = (m: "get" | "post", path: string, body?: object) => {
  const r = request(app)[m](`/api/v1/admin${path}`).set(H(tAdmin));
  return body ? r.send(body) : r;
};
const logs = async (action: string) => ((await db.query<any[]>("SELECT * FROM admin_audit_logs WHERE action = ?", [action]))[0] as any[]).length;

beforeAll(async () => {
  s = await siapCheckout();
  await createAdmin({ phone: "081300000009", fullName: "Admin Uji", password: "rahasia123" });
  tAdmin = await login("081300000009");
  const code = await pesanDulu(s.tCust, s.menu);
  for (const a of ["confirm", "cook", "ready", "complete"]) await request(app).post(`/api/v1/merchant/orders/${code}/${a}`).set(H(s.tA)).expect(200);
  await request(app).post(`/api/v1/orders/${code}/reviews`).set(H(s.tCust)).send({ items: [{ menu_id: s.menu, rating: 1, comment: "Spam promo judi" }] }).expect(201);
  ulasanId = ((await db.query<any[]>("SELECT id FROM reviews"))[0] as any[])[0].id;
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("ulasan", () => {
  test("daftar + filter; hanya admin", async () => {
    const r = await adm("get", "/reviews?q=judi").expect(200);
    expect(r.body.meta).toEqual({ page: 1, limit: 20, total: 1 });
    expect(r.body.data[0]).toMatchObject({ id: ulasanId, hidden: false, menu: { id: s.menu, name: "Nasi Ayam" }, merchant: { business_name: "Dapur Siti" }, customer_name: "Budi" });
    expect((await adm("get", "/reviews?status=moderated").expect(200)).body.data).toEqual([]);
    await adm("get", "/reviews?status=x").expect(400);
    await request(app).get("/api/v1/admin/reviews").set(H(s.tA)).expect(403);
  });

  test("hide wajib alasan; rating & daftar publik/toko mengabaikan; idempoten; unhide memulihkan", async () => {
    await adm("post", `/reviews/${ulasanId}/hide`, {}).expect(400);
    const r = await adm("post", `/reviews/${ulasanId}/hide`, { reason: "Spam" }).expect(200);
    expect(r.body.data).toMatchObject({ hidden: true, hidden_reason: "Spam" });
    expect(await menuRow(s.menu)).toMatchObject({ rating_avg: "0.00", rating_count: 0 });
    expect((await request(app).get(`/api/v1/menus/${s.menu}/reviews`).expect(200)).body.meta.total).toBe(0);
    expect((await request(app).get("/api/v1/merchant/reviews").set(H(s.tA)).expect(200)).body.data).toEqual([]);
    await adm("post", `/reviews/${ulasanId}/hide`, { reason: "Lagi" }).expect(200);
    expect(await logs("review.hide")).toBe(1);

    expect((await adm("post", `/reviews/${ulasanId}/unhide`).expect(200)).body.data).toMatchObject({ hidden: false, hidden_reason: null });
    expect(await menuRow(s.menu)).toMatchObject({ rating_avg: "1.00", rating_count: 1 });
    expect(await logs("review.unhide")).toBe(1);
    await adm("post", "/reviews/999999/hide", { reason: "x" }).expect(404);
  });
});

describe("menu", () => {
  test("takedown: nonaktif, hilang dari katalog, penjual tidak bisa mengaktifkan; restore: penjual boleh lagi", async () => {
    const r = await adm("post", `/menus/${s.menu2}/takedown`, { reason: "Foto melanggar" }).expect(200);
    expect(r.body.data).toMatchObject({ id: s.menu2, is_active: false, moderated: true, moderation_reason: "Foto melanggar", merchant: { id: s.idA } });
    expect(await logs("menu.takedown")).toBe(1);
    await request(app).get(`/api/v1/menus/${s.menu2}`).expect(404);
    const aktifkan = () => request(app).patch(`/api/v1/merchant/menus/${s.menu2}`).set(H(s.tA)).send({ is_active: true });
    expect((await aktifkan().expect(409)).body.error.message).toBe("Menu ini diturunkan admin: Foto melanggar. Hubungi admin untuk memulihkan.");
    expect((await adm("get", "/menus?status=moderated").expect(200)).body.data.map((m: { id: number }) => m.id)).toEqual([s.menu2]);

    expect((await adm("post", `/menus/${s.menu2}/restore`).expect(200)).body.data).toMatchObject({ moderated: false, is_active: false });
    await aktifkan().expect(200);
    expect(await logs("menu.restore")).toBe(1);
  });

  test("daftar menu admin memuat foto tambahan (gallery) agar ikut dimoderasi; tanpa foto tambahan → []", async () => {
    const g = ["https://foto.test/merchants/1/menu/a.jpg", "https://foto.test/merchants/1/menu/b.jpg"];
    await db.query("UPDATE menus SET gallery = ? WHERE id = ?", [JSON.stringify(g), s.menu]);
    const rows: { id: number; gallery: string[] }[] = (await adm("get", "/menus").expect(200)).body.data;
    expect(rows.find((m) => m.id === s.menu)!.gallery).toEqual(g);
    expect(rows.find((m) => m.id === s.menu2)!.gallery).toEqual([]);
  });

  test("hapus satu foto: foto tambahan dikeluarkan; foto utama diganti foto tambahan pertama; tercatat di audit; menu tetap dijual", async () => {
    const [utama, a, b] = ["u", "a", "b"].map((n) => `https://foto.test/merchants/${s.idA}/menu/${n}.jpg`);
    await db.query("UPDATE menus SET image_url = ?, gallery = ?, is_active = TRUE WHERE id = ?", [utama, JSON.stringify([a, b]), s.menu]);
    const hapus = (url: string, reason = "Foto tidak sesuai") => adm("post", `/menus/${s.menu}/photos/remove`, { url, reason });

    const r1 = (await hapus(a).expect(200)).body.data;
    expect(r1).toMatchObject({ id: s.menu, image_url: utama, gallery: [b], is_active: true, moderated: false });
    const r2 = (await hapus(utama, "Foto bukan makanan").expect(200)).body.data;
    expect(r2).toMatchObject({ image_url: b, gallery: [] });
    expect((await hapus(b).expect(200)).body.data).toMatchObject({ image_url: null, gallery: [] });

    const [log] = await db.query<any[]>("SELECT reason, before_json, after_json FROM admin_audit_logs WHERE action = 'menu.photo_remove' ORDER BY id");
    expect(log.length).toBe(3);
    expect(log[1].reason).toBe("Foto bukan makanan");
    const json = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);
    expect(json(log[1].before_json)).toEqual({ image_url: utama, gallery: [b] });
    expect(json(log[1].after_json)).toEqual({ image_url: b, gallery: [] });
  });

  test("hapus foto → notifikasi ke penjual pemilik menu (nama menu + alasan), terlihat di GET /me/notifications", async () => {
    const foto = `https://foto.test/merchants/${s.idA}/menu/n.jpg`;
    await db.query("UPDATE menus SET gallery = ? WHERE id = ?", [JSON.stringify([foto]), s.menu]);
    await adm("post", `/menus/${s.menu}/photos/remove`, { url: foto, reason: "Foto buram" }).expect(200);
    const r = (await request(app).get("/api/v1/me/notifications?type=moderation").set(H(s.tA)).expect(200)).body;
    expect(r.data[0]).toMatchObject({ type: "moderation", title: "Foto menu dihapus admin" });
    expect(r.data[0].body).toContain("Foto buram");
    expect(r.data[0].body).toContain(String(((await menuRow(s.menu)) as { name: string }).name));
    expect(r.meta.unread_count).toBeGreaterThan(0);
    // penjual lain tidak menerima
    expect((await request(app).get("/api/v1/me/notifications?type=moderation").set(H(s.tB)).expect(200)).body.data).toEqual([]);
  });

  test("hapus foto: URL bukan milik menu → 404; alasan kosong → 400; menu tidak ada → 404", async () => {
    const lain = `https://foto.test/merchants/${s.idA}/menu/lain.jpg`;
    expect((await adm("post", `/menus/${s.menu2}/photos/remove`, { url: lain, reason: "x" }).expect(404)).body.error.message).toBe("Foto tidak ditemukan di menu ini.");
    expect((await adm("post", `/menus/${s.menu2}/photos/remove`, { url: lain }).expect(400)).body.error.fields.reason).toBeDefined();
    expect((await adm("post", `/menus/${s.menu2}/photos/remove`, { reason: "x" }).expect(400)).body.error.fields.url).toBeDefined();
    await adm("post", "/menus/999999/photos/remove", { url: lain, reason: "x" }).expect(404);
  });
});
