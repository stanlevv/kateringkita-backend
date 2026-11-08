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
});
