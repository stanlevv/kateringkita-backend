import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { env } from "../src/config/env";
import { createAdmin } from "../src/scripts/create-admin";
import { freezeClock, login, makeVisible, photoUrl, prepareCheckout, setR2Env } from "./helpers/merchant";

// Arsip dan ubah konten admin (F33): promo platform, banner, dan pop-up diarsipkan (bukan dihapus) dan bisa
// dipulihkan; konten arsip tidak tampil di aplikasi dan promo arsip tidak bisa dipakai saat checkout.
let setup: Awaited<ReturnType<typeof prepareCheckout>>;
let adminToken: string, supportToken: string;
const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });
const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 3600e3).toISOString();
const admin = (method: "get" | "post" | "patch", path: string, body?: object, token = adminToken) =>
  request(app)[method](`/api/v1/admin${path}`).set(authHeader(token)).send(body);
const asCustomer = (method: "get" | "post", path: string) =>
  request(app)[method](`/api/v1${path}`).set(authHeader(setup.customerToken));
const promo = async (code: string, merchantId: number | null = null) =>
  (
    await db.query<any>(
      `INSERT INTO promos (merchant_id, code, type, value, starts_at, ends_at)
       VALUES (?, ?, 'fixed', 3000, UTC_TIMESTAMP() - INTERVAL 1 DAY, UTC_TIMESTAMP() + INTERVAL 5 DAY)`,
      [merchantId, code],
    )
  )[0].insertId as number;
const period = { starts_at: hoursFromNow(-24), ends_at: hoursFromNow(48) };
const platformBanner = (overrides: Record<string, unknown> = {}) =>
  admin("post", "/banners", {
    title: "Banner platform",
    image_url: photoUrl("platform/banner/"),
    target: "none",
    ...period,
    ...overrides,
  }).expect(201);
const popup = (overrides: Record<string, unknown> = {}) =>
  admin("post", "/popups", {
    title: "Pop-up promo",
    image_url: photoUrl("platform/popup/"),
    ...period,
    ...overrides,
  }).expect(201);
const auditCount = async (action: string, targetId: number) =>
  Number(
    (
      (
        await db.query<any[]>("SELECT COUNT(*) AS n FROM admin_audit_logs WHERE action = ? AND target_id = ?", [
          action,
          String(targetId),
        ])
      )[0] as any[]
    )[0].n,
  );
const cart = (extra: Record<string, unknown>) => ({
  items: [{ menu_id: setup.menu, qty: 2 }],
  pickup_point_id: 1,
  ...extra,
});
const quote = (codes: string[]) => asCustomer("post", "/orders/quote").send(cart({ promo_codes: codes }));
const checkout = (codes: string[]) =>
  asCustomer("post", "/orders")
    .set("Idempotency-Key", randomUUID())
    .send(cart({ promo_codes: codes, payment_method: "va" }));

beforeAll(async () => {
  setup = await prepareCheckout();
  await makeVisible(setup.idB);
  await createAdmin({ phone: "081300000009", fullName: "Admin Super", password: "rahasia123" });
  await createAdmin({ phone: "081300000011", fullName: "Admin Support", password: "rahasia123" });
  await db.query("UPDATE users SET admin_level = 'support' WHERE phone = '081300000011'");
  [adminToken, supportToken] = [await login("081300000009"), await login("081300000011")];
  setR2Env();
});
beforeEach(() => {
  freezeClock();
  env.MIDTRANS_SERVER_KEY = "SB-Mid-server-uji";
});
afterEach(async () => {
  env.MIDTRANS_SERVER_KEY = undefined;
  await db.query("UPDATE orders SET status = 'expired' WHERE status = 'holding'");
  await db.query("UPDATE menus SET held_today = 0");
});
afterAll(() => {
  setR2Env(false);
});

describe("arsip promo platform", () => {
  test("arsip dan pulihkan idempoten, log tertulis sekali, filter ?archived=true", async () => {
    const id = await promo("ARSIP1");
    const archived = (await admin("post", `/promos/${id}/archive`).expect(200)).body.data;
    expect(archived).toMatchObject({ id, code: "ARSIP1" });
    expect(typeof archived.archived_at).toBe("string");
    await admin("post", `/promos/${id}/archive`).expect(200);
    expect(await auditCount("promo.archive", id)).toBe(1);

    const active = (await admin("get", "/promos").expect(200)).body.data;
    expect(active.map((row: any) => row.id)).not.toContain(id);
    expect(active.every((row: any) => row.archived_at === null)).toBe(true);
    const inArchive = (await admin("get", "/promos?archived=true").expect(200)).body.data;
    expect(inArchive.map((row: any) => row.id)).toEqual([id]);

    expect((await admin("post", `/promos/${id}/restore`).expect(200)).body.data.archived_at).toBeNull();
    await admin("post", `/promos/${id}/restore`).expect(200);
    expect(await auditCount("promo.restore", id)).toBe(1);
    expect((await admin("get", "/promos").expect(200)).body.data.map((row: any) => row.id)).toContain(id);
  });

  test("promo toko tidak bisa diarsipkan lewat admin (404)", async () => {
    const id = await promo("TOKOARSIP", setup.idA);
    await admin("post", `/promos/${id}/archive`).expect(404);
  });

  test("promo arsip hilang dari /vouchers/platform, tidak bisa diklaim, dan hilang dari Voucher Saya", async () => {
    const id = await promo("ARSIPKLAIM");
    await asCustomer("post", `/me/vouchers/${id}/claim`).expect(200);
    await admin("post", `/promos/${id}/archive`).expect(200);
    const platform = (await request(app).get("/api/v1/vouchers/platform").expect(200)).body.data;
    expect(platform.map((card: any) => card.id)).not.toContain(id);
    const mine = (await asCustomer("get", "/me/vouchers").expect(200)).body.data;
    expect(mine.map((card: any) => card.id)).not.toContain(id);

    const other = await promo("ARSIPKLAIM2");
    await admin("post", `/promos/${other}/archive`).expect(200);
    const res = await asCustomer("post", `/me/vouchers/${other}/claim`).expect(409);
    expect(res.body.error.message).toBe("Voucher sedang tidak tersedia.");
  });

  test("promo arsip ditolak di quote dan checkout, lewat kode maupun voucher klaim; pulih bisa dipakai lagi", async () => {
    const id = await promo("ARSIPPAKAI");
    await asCustomer("post", `/me/vouchers/${id}/claim`).expect(200);
    await quote(["ARSIPPAKAI"]).expect(200);
    await admin("post", `/promos/${id}/archive`).expect(200);
    for (const res of [await quote(["arsippakai"]), await checkout(["ARSIPPAKAI"])]) {
      expect(res.status).toBe(422);
      expect(res.body.error.fields.promo_codes).toEqual(["Kode promo tidak ditemukan."]);
    }
    await admin("post", `/promos/${id}/restore`).expect(200);
    expect((await quote(["ARSIPPAKAI"]).expect(200)).body.data.platform_discount).toBe(3000);
  });

  test("pesanan lama yang memakai promo arsip tetap menampilkan potongannya", async () => {
    const id = await promo("ARSIPLAMA");
    const code = (await checkout(["ARSIPLAMA"]).expect(201)).body.data.code;
    await admin("post", `/promos/${id}/archive`).expect(200);
    expect((await asCustomer("get", `/orders/${code}`).expect(200)).body.data.discount).toBe(3000);
    const [[row]] = await db.query<any[]>(
      `SELECT o.platform_promo_id, o.platform_discount, (SELECT COUNT(*) FROM promo_redemptions r WHERE r.order_id = o.id) AS n
       FROM orders o WHERE o.code = ?`,
      [code],
    );
    expect(row).toMatchObject({ platform_promo_id: id, platform_discount: 3000, n: 1 });
  });

  test("promo yang dipakai pop-up atau banner yang belum diarsipkan → 409 PROMO_IN_USE", async () => {
    const id = await promo("ARSIPDIPAKAI");
    const popupId = (await popup({ title: "Pop-up hemat", promo_id: id })).body.data.id;
    let res = await admin("post", `/promos/${id}/archive`).expect(409);
    expect(res.body.error).toMatchObject({
      code: "PROMO_IN_USE",
      message: "Promo masih dipakai di pop-up atau banner: Pop-up hemat.",
    });
    await admin("post", `/popups/${popupId}/archive`).expect(200);
    const bannerId = (await platformBanner({ title: "Banner hemat", target: "promo", promo_id: id })).body.data.id;
    res = await admin("post", `/promos/${id}/archive`).expect(409);
    expect(res.body.error.message).toBe("Promo masih dipakai di pop-up atau banner: Banner hemat.");
    await admin("post", `/banners/${bannerId}/archive`).expect(200);
    await admin("post", `/promos/${id}/archive`).expect(200);
    expect(await auditCount("promo.archive", id)).toBe(1);

    // memulihkan konten yang menunjuk promo arsip ditolak
    for (const path of [`/popups/${popupId}/restore`, `/banners/${bannerId}/restore`]) {
      res = await admin("post", path).expect(409);
      expect(res.body.error).toMatchObject({
        code: "PROMO_ARCHIVED",
        message: "Pulihkan dulu promo yang dipakai konten ini.",
      });
    }
    // promo arsip juga tidak bisa dipilih untuk pop-up atau banner baru
    await admin("post", "/popups", {
      title: "Pop-up baru",
      image_url: photoUrl("platform/popup/"),
      ...period,
      promo_id: id,
    }).expect(400);
    await admin("post", `/promos/${id}/restore`).expect(200);
    await admin("post", `/popups/${popupId}/restore`).expect(200);
  });
});

describe("arsip banner dan pop-up", () => {
  test("banner platform dan toko diarsipkan: hilang dari /banners walau masih tayang, bisa dipulihkan", async () => {
    const platformId = (await platformBanner()).body.data.id;
    const [merchantBanner] = await db.query<any>(
      `INSERT INTO banners (merchant_id, title, image_url, target, status, starts_at, ends_at)
       VALUES (?, 'Banner toko', 'https://foto.test/x.png', 'merchant', 'disetujui', UTC_TIMESTAMP() - INTERVAL 1 DAY, UTC_TIMESTAMP() + INTERVAL 2 DAY)`,
      [setup.idA],
    );
    const merchantId = merchantBanner.insertId as number;
    const publicIds = async () =>
      (await request(app).get("/api/v1/banners").expect(200)).body.data.map((b: any) => b.id);
    expect(await publicIds()).toEqual(expect.arrayContaining([platformId, merchantId]));

    for (const id of [platformId, merchantId]) {
      const data = (await admin("post", `/banners/${id}/archive`).expect(200)).body.data;
      expect(typeof data.archived_at).toBe("string");
      await admin("post", `/banners/${id}/archive`).expect(200);
      expect(await auditCount("banner.archive", id)).toBe(1);
    }
    const afterArchive = await publicIds();
    expect(afterArchive).not.toContain(platformId);
    expect(afterArchive).not.toContain(merchantId);
    expect((await admin("get", "/banners").expect(200)).body.data.map((b: any) => b.id)).not.toContain(platformId);
    const archived = (await admin("get", "/banners?archived=true").expect(200)).body.data;
    expect(archived.map((b: any) => b.id)).toEqual(expect.arrayContaining([platformId, merchantId]));
    expect(archived.every((b: any) => typeof b.archived_at === "string")).toBe(true);

    expect((await admin("post", `/banners/${platformId}/restore`).expect(200)).body.data.archived_at).toBeNull();
    await admin("post", `/banners/${platformId}/restore`).expect(200);
    expect(await auditCount("banner.restore", platformId)).toBe(1);
    expect(await publicIds()).toContain(platformId);
    await admin("post", `/banners/${platformId}/archive`).expect(200);
  });

  test("pop-up arsip hilang dari /popup walau masih tayang; daftar admin dan filter arsip", async () => {
    const id = (await popup({ title: "Pop-up arsip" })).body.data.id;
    expect((await request(app).get("/api/v1/popup").expect(200)).body.data?.id).toBe(id);
    const data = (await admin("post", `/popups/${id}/archive`).expect(200)).body.data;
    expect(typeof data.archived_at).toBe("string");
    await admin("post", `/popups/${id}/archive`).expect(200);
    expect(await auditCount("popup.archive", id)).toBe(1);
    expect((await request(app).get("/api/v1/popup").expect(200)).body.data?.id).not.toBe(id);
    expect((await admin("get", "/popups").expect(200)).body.data.map((p: any) => p.id)).not.toContain(id);
    expect((await admin("get", "/popups?archived=true").expect(200)).body.data.map((p: any) => p.id)).toContain(id);

    expect((await admin("post", `/popups/${id}/restore`).expect(200)).body.data.archived_at).toBeNull();
    await admin("post", `/popups/${id}/restore`).expect(200);
    expect(await auditCount("popup.restore", id)).toBe(1);
    expect((await request(app).get("/api/v1/popup").expect(200)).body.data?.id).toBe(id);
    await admin("post", `/popups/${id}/archive`).expect(200);
  });

  test("banner toko arsip: penjual tak bisa ajukan ulang; pulihkan ditolak bila ada banner aktif lain", async () => {
    const insertBanner = async (status: string) =>
      (
        await db.query<any>(
          `INSERT INTO banners (merchant_id, title, image_url, target, status, starts_at, ends_at)
           VALUES (?, 'Banner toko B', 'https://foto.test/b.png', 'merchant', ?, UTC_TIMESTAMP() - INTERVAL 1 DAY, UTC_TIMESTAMP() + INTERVAL 2 DAY)`,
          [setup.idB, status],
        )
      )[0].insertId as number;
    const asMerchantB = (method: "get" | "patch", path: string) =>
      request(app)[method](`/api/v1/merchant${path}`).set(authHeader(setup.tokenB));
    const id = await insertBanner("disetujui");
    await admin("post", `/banners/${id}/archive`).expect(200);

    const mine = (await asMerchantB("get", "/banners").expect(200)).body.data.find((b: any) => b.id === id);
    expect(typeof mine.archived_at).toBe("string");
    const res = await asMerchantB("patch", `/banners/${id}`).send({ title: "Ajukan ulang" }).expect(409);
    expect(res.body.error).toMatchObject({ code: "BANNER_ARCHIVED", message: "Banner ini diarsipkan admin." });

    const other = await insertBanner("menunggu");
    const restore = await admin("post", `/banners/${id}/restore`).expect(409);
    expect(restore.body.error.message).toBe("Toko ini sudah punya banner aktif.");
    await db.query("DELETE FROM banners WHERE id IN (?, ?)", [id, other]);
  });

  test("id tidak ada → 404", async () => {
    for (const path of ["/promos/999999/archive", "/banners/999999/restore", "/popups/abc/archive"])
      await admin("post", path).expect(404);
  });
});

describe("ubah isi banner platform", () => {
  test("PATCH /content mengubah judul, gambar, tujuan, dan masa tayang; dicatat di log", async () => {
    const id = (await platformBanner({ sort_order: 5 })).body.data.id;
    const target = await promo("BANNERUBAH");
    const image = photoUrl("platform/banner/");
    const data = (
      await admin("patch", `/banners/${id}/content`, {
        title: "Judul baru",
        image_url: image,
        target: "promo",
        promo_id: target,
        starts_at: hoursFromNow(-2),
        ends_at: hoursFromNow(72),
      }).expect(200)
    ).body.data;
    expect(data).toMatchObject({ id, title: "Judul baru", image_url: image, target: "promo", sort_order: 5 });
    expect(data.promo).toMatchObject({ id: target, code: "BANNERUBAH" });
    expect(await auditCount("banner.update", id)).toBe(1);
  });

  test("gambar dari folder lain ditolak (banner dan pop-up)", async () => {
    const id = (await platformBanner()).body.data.id;
    const res = await admin("patch", `/banners/${id}/content`, {
      title: "Judul baru",
      image_url: photoUrl("platform/popup/"),
      target: "none",
      ...period,
    }).expect(400);
    expect(res.body.error.fields.image_url).toBeDefined();
    const popupId = (await popup()).body.data.id;
    const popupRes = await admin("patch", `/popups/${popupId}`, { image_url: photoUrl("platform/banner/") }).expect(
      400,
    );
    expect(popupRes.body.error.fields.image_url).toBeDefined();
  });

  test("banner toko → 409 MERCHANT_BANNER", async () => {
    const [result] = await db.query<any>(
      `INSERT INTO banners (merchant_id, title, image_url, target, status, starts_at, ends_at)
       VALUES (?, 'Banner toko', 'https://foto.test/y.png', 'merchant', 'menunggu', UTC_TIMESTAMP(), UTC_TIMESTAMP() + INTERVAL 2 DAY)`,
      [setup.idB],
    );
    const res = await admin("patch", `/banners/${result.insertId}/content`, {
      title: "Diubah admin",
      image_url: photoUrl("platform/banner/"),
      target: "none",
      ...period,
    }).expect(409);
    expect(res.body.error).toMatchObject({
      code: "MERCHANT_BANNER",
      message: "Isi banner toko hanya bisa diubah penjualnya.",
    });
  });
});

describe("support hanya melihat", () => {
  test("ubah, arsip, dan pulihkan → 403; daftar arsip boleh dibaca", async () => {
    const promoId = await promo("SUPPORTARSIP");
    const bannerId = (await platformBanner()).body.data.id;
    const popupId = (await popup()).body.data.id;
    for (const path of [
      `/promos/${promoId}/archive`,
      `/promos/${promoId}/restore`,
      `/banners/${bannerId}/archive`,
      `/banners/${bannerId}/restore`,
      `/popups/${popupId}/archive`,
      `/popups/${popupId}/restore`,
    ])
      await admin("post", path, undefined, supportToken).expect(403);
    await admin("patch", `/banners/${bannerId}/content`, { title: "x" }, supportToken).expect(403);
    await admin("patch", `/popups/${popupId}`, { title: "Diubah support" }, supportToken).expect(403);
    for (const path of ["/promos?archived=true", "/banners?archived=true", "/popups?archived=true"])
      await admin("get", path, undefined, supportToken).expect(200);
  });
});
