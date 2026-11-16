import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { createAdmin } from "../src/scripts/create-admin";
import { R2_UJI, fotoUrl, isiR2, login, siapkanToko, tampilkan } from "./helpers/toko";

// Banner beranda (rancangan voucher 2026-11-16 §5.4): penjual mengajukan (1 aktif per toko), admin menyetujui / menolak /
// membuat banner platform; publik maks 8 banner tayang, admin dulu; banner ke promo mati / toko tersembunyi disembunyikan.
let s: Awaited<ReturnType<typeof siapkanToko>>;
let tAdmin: string, tSupport: string, adminId: number, promoA: number, promoB: number, promoPlat: number;
const H = (t: string) => ({ Authorization: `Bearer ${t}` });
const jam = (h: number) => new Date(Date.now() + h * 3600e3).toISOString();
const isiToko = (o: Record<string, unknown> = {}) => ({
  title: "Diskon pembukaan", image_url: fotoUrl(`merchants/${s.idA}/banner/`), target: "merchant", starts_at: jam(-1), ends_at: jam(48), ...o,
});
const ajukan = (o: Record<string, unknown> = {}, t = s.tA) => request(app).post("/api/v1/merchant/banners").set(H(t)).send(isiToko(o));
const admin = (m: "get" | "post" | "patch", u: string, b?: object, t = tAdmin) => request(app)[m](`/api/v1/admin${u}`).set(H(t)).send(b);
const publik = (t?: string) => (t ? request(app).get("/api/v1/banners").set(H(t)) : request(app).get("/api/v1/banners"));
const promo = async (merchantId: number | null, code: string) => ((await db.query<any>(
  `INSERT INTO promos (merchant_id, code, type, value, starts_at, ends_at)
   VALUES (?, ?, 'fixed', 1000, UTC_TIMESTAMP() - INTERVAL 1 DAY, UTC_TIMESTAMP() + INTERVAL 5 DAY)`, [merchantId, code],
))[0]).insertId as number;

beforeAll(async () => {
  s = await siapkanToko();
  vi.restoreAllMocks();
  await tampilkan(s.idA);
  await tampilkan(s.idB);
  adminId = (await createAdmin({ phone: "081300000009", fullName: "Admin Super", password: "rahasia123" })).id;
  await createAdmin({ phone: "081300000011", fullName: "Admin Support", password: "rahasia123" });
  await db.query("UPDATE users SET admin_level = 'support' WHERE phone = '081300000011'");
  [tAdmin, tSupport] = [await login("081300000009"), await login("081300000011")];
  promoA = await promo(s.idA, "BANNERA");
  promoB = await promo(s.idB, "BANNERB");
  promoPlat = await promo(null, "BANNERPLAT");
  isiR2();
});
beforeEach(async () => {
  await db.query("DELETE FROM banners");
  await db.query("DELETE FROM admin_audit_logs");
});
afterAll(() => {
  isiR2(false);
});

describe("penjual mengajukan banner", () => {
  test("status menunggu, tidak tampil publik; maks 1 banner aktif per toko", async () => {
    const r = await ajukan().expect(201);
    expect(r.body.data).toMatchObject({ title: "Diskon pembukaan", target: "merchant", status: "menunggu", catatan: null, promo: null });
    expect((await publik().expect(200)).body.data).toEqual([]);
    expect((await ajukan().expect(409)).body.error.message).toBe("Toko ini sudah punya banner aktif.");
    expect((await request(app).get("/api/v1/merchant/banners").set(H(s.tA)).expect(200)).body.data).toHaveLength(1);
    expect((await request(app).get("/api/v1/merchant/banners").set(H(s.tB)).expect(200)).body.data).toHaveLength(0);
  });

  test("validasi: judul, gambar dari folder tokonya, voucher milik tokonya, periode", async () => {
    const r = await ajukan({ title: "ab", image_url: `${R2_UJI.R2_PUBLIC_URL}/merchants/${s.idB}/banner/x.png`, ends_at: jam(-2) }).expect(400);
    expect(Object.keys(r.body.error.fields).sort()).toEqual(["ends_at", "image_url", "title"]);
    expect((await ajukan({ target: "promo", promo_id: promoB }).expect(400)).body.error.fields.promo_id).toEqual(["Pilih voucher milik tokomu."]);
    expect((await ajukan({ target: "promo" }).expect(400)).body.error.fields.promo_id).toEqual(["Pilih voucher milik tokomu."]);
    await ajukan({ target: "promo", promo_id: promoA }).expect(201);
  });

  test("diubah setelah disetujui → kembali menunggu; hapus", async () => {
    const id = (await ajukan().expect(201)).body.data.id;
    await admin("patch", `/banners/${id}`, { status: "disetujui" }).expect(200);
    const u = await request(app).patch(`/api/v1/merchant/banners/${id}`).set(H(s.tA)).send({ title: "Judul baru" }).expect(200);
    expect(u.body.data).toMatchObject({ title: "Judul baru", status: "menunggu" });
    await request(app).patch(`/api/v1/merchant/banners/${id}`).set(H(s.tB)).send({ title: "Bukan milikmu" }).expect(404);
    await request(app).delete(`/api/v1/merchant/banners/${id}`).set(H(s.tA)).expect(200);
    expect((await request(app).get("/api/v1/merchant/banners").set(H(s.tA))).body.data).toEqual([]);
  });
});

describe("admin meninjau & membuat banner", () => {
  test("setujui → tayang; tolak wajib alasan, alasan terlihat penjual; diaudit", async () => {
    const id = (await ajukan({ target: "promo", promo_id: promoA }).expect(201)).body.data.id;
    expect((await admin("get", "/banners?status=menunggu").expect(200)).body.data.map((b: any) => b.id)).toEqual([id]);
    expect((await admin("patch", `/banners/${id}`, { status: "ditolak" }).expect(400)).body.error.fields.catatan)
      .toEqual(["Tulis alasan penolakan (3–300 karakter)."]);
    await admin("patch", `/banners/${id}`, { status: "ditolak", catatan: "Gambar buram" }).expect(200);
    expect((await request(app).get("/api/v1/merchant/banners").set(H(s.tA))).body.data[0]).toMatchObject({ status: "ditolak", catatan: "Gambar buram" });
    await admin("patch", `/banners/${id}`, { status: "disetujui" }).expect(200);
    const p = (await publik(s.tCust).expect(200)).body.data;
    expect(p).toEqual([{
      id, title: "Diskon pembukaan", image_url: expect.any(String), target: "promo",
      promo: expect.objectContaining({ id: promoA, code: "BANNERA", claimed: false }), merchant: { id: s.idA, slug: expect.any(String), business_name: "Dapur Siti" },
    }]);
    const [log] = await db.query<any[]>("SELECT action, target_type FROM admin_audit_logs ORDER BY id");
    expect(log.map((l: any) => l.action)).toEqual(["banner.reject", "banner.approve"]);
  });

  test("banner platform dari admin langsung tayang, dulu dari banner toko; urutan sort_order", async () => {
    const t = (await ajukan().expect(201)).body.data.id;
    await admin("patch", `/banners/${t}`, { status: "disetujui" }).expect(200);
    const isi = { image_url: fotoUrl("platform/banner/"), starts_at: jam(-1), ends_at: jam(24) };
    const a = (await admin("post", "/banners", { ...isi, title: "Voucher KateringKita", target: "promo", promo_id: promoPlat, sort_order: 2 }).expect(201)).body.data;
    const b = (await admin("post", "/banners", { ...isi, title: "Info kampus", target: "none", sort_order: 1 }).expect(201)).body.data;
    expect(a.status).toBe("disetujui");
    expect((await publik().expect(200)).body.data.map((x: any) => x.id)).toEqual([b.id, a.id, t]);
    await admin("patch", `/banners/${b.id}`, { status: "nonaktif" }).expect(200);
    expect((await publik()).body.data.map((x: any) => x.id)).toEqual([a.id, t]);
  });

  test("tidak tayang: di luar periode, promo target mati, toko tersembunyi; maks 8", async () => {
    const isi = { image_url: fotoUrl("platform/banner/"), title: "Banner", target: "none" };
    await admin("post", "/banners", { ...isi, starts_at: jam(2), ends_at: jam(24) }).expect(201);
    const mati = await promo(null, "MATIBANNER");
    await admin("post", "/banners", { ...isi, target: "promo", promo_id: mati, starts_at: jam(-1), ends_at: jam(24) }).expect(201);
    await db.query("UPDATE promos SET is_active = FALSE WHERE id = ?", [mati]);
    const t = (await ajukan().expect(201)).body.data.id;
    await admin("patch", `/banners/${t}`, { status: "disetujui" }).expect(200);
    await db.query("UPDATE merchants SET verification_status = 'pending' WHERE id = ?", [s.idA]);
    expect((await publik()).body.data).toEqual([]);
    await tampilkan(s.idA);
    for (let i = 0; i < 9; i++) await admin("post", "/banners", { ...isi, starts_at: jam(-1), ends_at: jam(24) }).expect(201);
    expect((await publik()).body.data).toHaveLength(8);
  });

  test("akses: support hanya melihat; unggah gambar admin ke folder platform", async () => {
    await admin("get", "/banners", undefined, tSupport).expect(200);
    await admin("post", "/banners", { title: "x" }, tSupport).expect(403);
    const u = await admin("post", "/uploads", { purpose: "banner", content_type: "image/png", size: 1000 }).expect(200);
    expect(u.body.data.public_url).toMatch(new RegExp(`^${R2_UJI.R2_PUBLIC_URL}/platform/banner/`));
    await admin("post", "/uploads", { purpose: "logo", content_type: "image/png", size: 1000 }).expect(400);
    const m = await request(app).post("/api/v1/merchant/uploads").set(H(s.tA)).send({ purpose: "banner", content_type: "image/png", size: 1000 }).expect(200);
    expect(m.body.data.public_url).toMatch(new RegExp(`/merchants/${s.idA}/banner/`));
    expect(adminId).toBeGreaterThan(0);
  });
});
