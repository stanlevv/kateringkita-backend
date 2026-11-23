import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { createAdmin } from "../src/scripts/create-admin";
import { TEST_R2_ENV, photoUrl, setR2Env, login, prepareMerchants, makeVisible } from "./helpers/merchant";

// Banner beranda (rancangan voucher 2026-11-16 §5.4): penjual mengajukan (1 aktif per toko), admin menyetujui / menolak /
// membuat banner platform; publik maks 8 banner tayang, admin dulu; banner ke promo mati / toko tersembunyi disembunyikan.
let setup: Awaited<ReturnType<typeof prepareMerchants>>;
let adminToken: string, supportToken: string, adminId: number, promoA: number, promoB: number, promoPlat: number;
const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });
const jam = (hours: number) => new Date(Date.now() + hours * 3600e3).toISOString();
const isiToko = (overrides: Record<string, unknown> = {}) => ({
  title: "Diskon pembukaan",
  image_url: photoUrl(`merchants/${setup.idA}/banner/`),
  target: "merchant",
  starts_at: jam(-1),
  ends_at: jam(48),
  ...overrides,
});
const ajukan = (overrides: Record<string, unknown> = {}, token = setup.tokenA) =>
  request(app).post("/api/v1/merchant/banners").set(authHeader(token)).send(isiToko(overrides));
const admin = (method: "get" | "post" | "patch", path: string, body?: object, token = adminToken) =>
  request(app)[method](`/api/v1/admin${path}`).set(authHeader(token)).send(body);
const publik = (token?: string) =>
  token ? request(app).get("/api/v1/banners").set(authHeader(token)) : request(app).get("/api/v1/banners");
const promo = async (merchantId: number | null, code: string) =>
  (
    await db.query<any>(
      `INSERT INTO promos (merchant_id, code, type, value, starts_at, ends_at)
   VALUES (?, ?, 'fixed', 1000, UTC_TIMESTAMP() - INTERVAL 1 DAY, UTC_TIMESTAMP() + INTERVAL 5 DAY)`,
      [merchantId, code],
    )
  )[0].insertId as number;

beforeAll(async () => {
  setup = await prepareMerchants();
  vi.restoreAllMocks();
  await makeVisible(setup.idA);
  await makeVisible(setup.idB);
  adminId = (await createAdmin({ phone: "081300000009", fullName: "Admin Super", password: "rahasia123" })).id;
  await createAdmin({ phone: "081300000011", fullName: "Admin Support", password: "rahasia123" });
  await db.query("UPDATE users SET admin_level = 'support' WHERE phone = '081300000011'");
  [adminToken, supportToken] = [await login("081300000009"), await login("081300000011")];
  promoA = await promo(setup.idA, "BANNERA");
  promoB = await promo(setup.idB, "BANNERB");
  promoPlat = await promo(null, "BANNERPLAT");
  setR2Env();
});
beforeEach(async () => {
  await db.query("DELETE FROM banners");
  await db.query("DELETE FROM admin_audit_logs");
});
afterAll(() => {
  setR2Env(false);
});
// Gambar pengajuan bisa diganti lewat URL unggah (presign) selama URL itu berlaku, jadi pengajuan baru hanya bisa
// disetujui setelah URL unggahnya kedaluwarsa; tes memundurkan waktunya
const lewatJendela = () => db.query("UPDATE banners SET updated_at = updated_at - INTERVAL 10 MINUTE");

describe("penjual mengajukan banner", () => {
  test("baru diajukan → belum bisa disetujui selama URL unggah gambarnya masih berlaku (409)", async () => {
    const id = (await ajukan().expect(201)).body.data.id;
    const res = await admin("patch", `/banners/${id}`, { status: "disetujui" }).expect(409);
    expect(res.body.error.message).toBe("Gambar banner baru saja diunggah. Setujui setelah 6 menit.");
    await admin("patch", `/banners/${id}`, { status: "ditolak", catatan: "Gambar buram" }).expect(200); // menolak tetap boleh
    await lewatJendela();
    await request(app)
      .patch(`/api/v1/merchant/banners/${id}`)
      .set(authHeader(setup.tokenA))
      .send({ title: "Judul baru" })
      .expect(200);
    await admin("patch", `/banners/${id}`, { status: "disetujui" }).expect(409); // diubah lagi → jendela mulai dari awal
  });

  test("status menunggu, tidak tampil publik; maks 1 banner aktif per toko", async () => {
    const res = await ajukan().expect(201);
    expect(res.body.data).toMatchObject({
      title: "Diskon pembukaan",
      target: "merchant",
      status: "menunggu",
      catatan: null,
      promo: null,
    });
    expect((await publik().expect(200)).body.data).toEqual([]);
    expect((await ajukan().expect(409)).body.error.message).toBe("Toko ini sudah punya banner aktif.");
    expect(
      (await request(app).get("/api/v1/merchant/banners").set(authHeader(setup.tokenA)).expect(200)).body.data,
    ).toHaveLength(1);
    expect(
      (await request(app).get("/api/v1/merchant/banners").set(authHeader(setup.tokenB)).expect(200)).body.data,
    ).toHaveLength(0);
  });

  test("validasi: judul, gambar dari folder tokonya, voucher milik tokonya, periode", async () => {
    const res = await ajukan({
      title: "ab",
      image_url: `${TEST_R2_ENV.R2_PUBLIC_URL}/merchants/${setup.idB}/banner/x.png`,
      ends_at: jam(-2),
    }).expect(400);
    expect(Object.keys(res.body.error.fields).sort()).toEqual(["ends_at", "image_url", "title"]);
    expect((await ajukan({ target: "promo", promo_id: promoB }).expect(400)).body.error.fields.promo_id).toEqual([
      "Pilih voucher milik tokomu.",
    ]);
    expect((await ajukan({ target: "promo" }).expect(400)).body.error.fields.promo_id).toEqual([
      "Pilih voucher milik tokomu.",
    ]);
    await ajukan({ target: "promo", promo_id: promoA }).expect(201);
  });

  test("diubah setelah disetujui → kembali menunggu; hapus", async () => {
    const id = (await ajukan().expect(201)).body.data.id;
    await lewatJendela();
    await admin("patch", `/banners/${id}`, { status: "disetujui" }).expect(200);
    const res = await request(app)
      .patch(`/api/v1/merchant/banners/${id}`)
      .set(authHeader(setup.tokenA))
      .send({ title: "Judul baru" })
      .expect(200);
    expect(res.body.data).toMatchObject({ title: "Judul baru", status: "menunggu" });
    await request(app)
      .patch(`/api/v1/merchant/banners/${id}`)
      .set(authHeader(setup.tokenB))
      .send({ title: "Bukan milikmu" })
      .expect(404);
    await request(app).delete(`/api/v1/merchant/banners/${id}`).set(authHeader(setup.tokenA)).expect(200);
    expect((await request(app).get("/api/v1/merchant/banners").set(authHeader(setup.tokenA))).body.data).toEqual([]);
  });
});

describe("admin meninjau & membuat banner", () => {
  test("setujui → tayang; tolak wajib alasan, alasan terlihat penjual; diaudit", async () => {
    const id = (await ajukan({ target: "promo", promo_id: promoA }).expect(201)).body.data.id;
    expect(
      (await admin("get", "/banners?status=menunggu").expect(200)).body.data.map((banner: any) => banner.id),
    ).toEqual([id]);
    expect(
      (await admin("patch", `/banners/${id}`, { status: "ditolak" }).expect(400)).body.error.fields.catatan,
    ).toEqual(["Tulis alasan penolakan (3–300 karakter)."]);
    await admin("patch", `/banners/${id}`, { status: "ditolak", catatan: "Gambar buram" }).expect(200);
    expect(
      (await request(app).get("/api/v1/merchant/banners").set(authHeader(setup.tokenA))).body.data[0],
    ).toMatchObject({
      status: "ditolak",
      catatan: "Gambar buram",
    });
    await lewatJendela();
    await admin("patch", `/banners/${id}`, { status: "disetujui" }).expect(200);
    const banners = (await publik(setup.customerToken).expect(200)).body.data;
    expect(banners).toEqual([
      {
        id,
        title: "Diskon pembukaan",
        image_url: expect.any(String),
        target: "promo",
        promo: expect.objectContaining({ id: promoA, code: "BANNERA", claimed: false }),
        merchant: { id: setup.idA, slug: expect.any(String), business_name: "Dapur Siti" },
      },
    ]);
    const [log] = await db.query<any[]>("SELECT action, target_type FROM admin_audit_logs ORDER BY id");
    expect(log.map((entry: any) => entry.action)).toEqual(["banner.reject", "banner.approve"]);
  });

  test("banner platform dari admin langsung tayang, dulu dari banner toko; urutan sort_order", async () => {
    const merchantBannerId = (await ajukan().expect(201)).body.data.id;
    await lewatJendela();
    await admin("patch", `/banners/${merchantBannerId}`, { status: "disetujui" }).expect(200);
    const isi = { image_url: photoUrl("platform/banner/"), starts_at: jam(-1), ends_at: jam(24) };
    const voucherBanner = (
      await admin("post", "/banners", {
        ...isi,
        title: "Voucher KateringKita",
        target: "promo",
        promo_id: promoPlat,
        sort_order: 2,
      }).expect(201)
    ).body.data;
    const infoBanner = (
      await admin("post", "/banners", { ...isi, title: "Info kampus", target: "none", sort_order: 1 }).expect(201)
    ).body.data;
    expect(voucherBanner.status).toBe("disetujui");
    expect((await publik().expect(200)).body.data.map((banner: any) => banner.id)).toEqual([
      infoBanner.id,
      voucherBanner.id,
      merchantBannerId,
    ]);
    await admin("patch", `/banners/${infoBanner.id}`, { status: "nonaktif" }).expect(200);
    expect((await publik()).body.data.map((banner: any) => banner.id)).toEqual([voucherBanner.id, merchantBannerId]);
  });

  test("tidak tayang: di luar periode, promo target mati, toko tersembunyi; maks 8", async () => {
    const isi = { image_url: photoUrl("platform/banner/"), title: "Banner", target: "none" };
    await admin("post", "/banners", { ...isi, starts_at: jam(2), ends_at: jam(24) }).expect(201);
    const mati = await promo(null, "MATIBANNER");
    await admin("post", "/banners", {
      ...isi,
      target: "promo",
      promo_id: mati,
      starts_at: jam(-1),
      ends_at: jam(24),
    }).expect(201);
    await db.query("UPDATE promos SET is_active = FALSE WHERE id = ?", [mati]);
    const bannerId = (await ajukan().expect(201)).body.data.id;
    await lewatJendela();
    await admin("patch", `/banners/${bannerId}`, { status: "disetujui" }).expect(200);
    await db.query("UPDATE merchants SET verification_status = 'pending' WHERE id = ?", [setup.idA]);
    expect((await publik()).body.data).toEqual([]);
    await makeVisible(setup.idA);
    for (let i = 0; i < 9; i++)
      await admin("post", "/banners", { ...isi, starts_at: jam(-1), ends_at: jam(24) }).expect(201);
    expect((await publik()).body.data).toHaveLength(8);
  });

  test("akses: support hanya melihat; unggah gambar admin ke folder platform", async () => {
    await admin("get", "/banners", undefined, supportToken).expect(200);
    await admin("post", "/banners", { title: "x" }, supportToken).expect(403);
    const res = await admin("post", "/uploads", { purpose: "banner", content_type: "image/png", size: 1000 }).expect(
      200,
    );
    expect(res.body.data.public_url).toMatch(new RegExp(`^${TEST_R2_ENV.R2_PUBLIC_URL}/platform/banner/`));
    await admin("post", "/uploads", { purpose: "logo", content_type: "image/png", size: 1000 }).expect(400);
    const merchantRes = await request(app)
      .post("/api/v1/merchant/uploads")
      .set(authHeader(setup.tokenA))
      .send({ purpose: "banner", content_type: "image/png", size: 1000 })
      .expect(200);
    expect(merchantRes.body.data.public_url).toMatch(new RegExp(`/merchants/${setup.idA}/banner/`));
    expect(adminId).toBeGreaterThan(0);
  });
});
