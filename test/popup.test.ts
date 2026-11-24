import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { createAdmin } from "../src/scripts/create-admin";
import { TEST_R2_ENV, photoUrl, setR2Env, login, prepareMerchants } from "./helpers/merchant";

// Pop-up promo mobile (rancangan voucher 2026-11-16 §5.5): admin saja; GET /popup = pop-up aktif terbaru dalam periode.
let setup: Awaited<ReturnType<typeof prepareMerchants>>;
let adminToken: string, supportToken: string, platformPromo: number, merchantPromo: number;
const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });
const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 3600e3).toISOString();
const popupBody = (overrides: Record<string, unknown> = {}) => ({
  title: "Promo akhir pekan",
  image_url: photoUrl("platform/popup/"),
  starts_at: hoursFromNow(-1),
  ends_at: hoursFromNow(24),
  ...overrides,
});
const createPopup = (overrides: Record<string, unknown> = {}, token = adminToken) =>
  request(app).post("/api/v1/admin/popups").set(authHeader(token)).send(popupBody(overrides));
const getPublic = (token?: string) =>
  token ? request(app).get("/api/v1/popup").set(authHeader(token)) : request(app).get("/api/v1/popup");
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
  await createAdmin({ phone: "081300000009", fullName: "Admin Super", password: "rahasia123" });
  await createAdmin({ phone: "081300000011", fullName: "Admin Support", password: "rahasia123" });
  await db.query("UPDATE users SET admin_level = 'support' WHERE phone = '081300000011'");
  [adminToken, supportToken] = [await login("081300000009"), await login("081300000011")];
  platformPromo = await promo(null, "POPUPPLAT");
  merchantPromo = await promo(setup.idA, "POPUPTOKO");
  setR2Env();
});
beforeEach(async () => {
  await db.query("DELETE FROM popups");
  await db.query("DELETE FROM admin_audit_logs");
});
afterAll(() => {
  setR2Env(false);
});

describe("GET /popup", () => {
  test("tanpa pop-up → null; pop-up aktif terbaru dengan voucher (claimed per pembeli)", async () => {
    expect((await getPublic().expect(200)).body).toEqual({ data: null });
    await createPopup({ title: "Lama" }).expect(201);
    const newer = (await createPopup({ title: "Baru", promo_id: platformPromo }).expect(201)).body.data;
    expect((await getPublic().expect(200)).body.data).toEqual({
      id: newer.id,
      title: "Baru",
      image_url: expect.any(String),
      promo: expect.objectContaining({ id: platformPromo, code: "POPUPPLAT", claimed: false }),
    });
    await request(app)
      .post(`/api/v1/me/vouchers/${platformPromo}/claim`)
      .set(authHeader(setup.customerToken))
      .expect(200);
    expect((await getPublic(setup.customerToken)).body.data.promo.claimed).toBe(true);
  });

  test("di luar periode, nonaktif, atau voucher tidak tersedia → tidak tampil", async () => {
    await createPopup({ starts_at: hoursFromNow(2), ends_at: hoursFromNow(24) }).expect(201);
    const id = (await createPopup().expect(201)).body.data.id;
    await request(app)
      .patch(`/api/v1/admin/popups/${id}`)
      .set(authHeader(adminToken))
      .send({ is_active: false })
      .expect(200);
    const inactivePromo = await promo(null, "POPUPMATI");
    await createPopup({ promo_id: inactivePromo }).expect(201);
    await db.query("UPDATE promos SET is_active = FALSE WHERE id = ?", [inactivePromo]);
    expect((await getPublic()).body.data).toBeNull();
  });
});

describe("admin pop-up", () => {
  test("validasi: judul, gambar folder platform, periode, voucher platform saja", async () => {
    const res = await createPopup({
      title: "ab",
      image_url: `${TEST_R2_ENV.R2_PUBLIC_URL}/merchants/1/logo/x.png`,
      ends_at: hoursFromNow(-3),
    }).expect(400);
    expect(Object.keys(res.body.error.fields).sort()).toEqual(["ends_at", "image_url", "title"]);
    expect((await createPopup({ promo_id: merchantPromo }).expect(400)).body.error.fields.promo_id).toEqual([
      "Pilih voucher platform.",
    ]);
  });

  test("daftar, ubah, diaudit; support hanya melihat", async () => {
    const id = (await createPopup().expect(201)).body.data.id;
    const res = await request(app)
      .patch(`/api/v1/admin/popups/${id}`)
      .set(authHeader(adminToken))
      .send({ title: "Judul baru", promo_id: platformPromo })
      .expect(200);
    expect(res.body.data).toMatchObject({
      title: "Judul baru",
      promo: { id: platformPromo, code: "POPUPPLAT" },
      is_active: true,
    });
    const listRes = await request(app).get("/api/v1/admin/popups").set(authHeader(supportToken)).expect(200);
    expect(listRes.body.data.map((popup: any) => popup.id)).toEqual([id]);
    await createPopup({}, supportToken).expect(403);
    const [log] = await db.query<any[]>("SELECT action FROM admin_audit_logs ORDER BY id");
    expect(log.map((entry: any) => entry.action)).toEqual(["popup.create", "popup.update"]);
    await request(app)
      .patch("/api/v1/admin/popups/999999")
      .set(authHeader(adminToken))
      .send({ is_active: false })
      .expect(404);
  });
});
