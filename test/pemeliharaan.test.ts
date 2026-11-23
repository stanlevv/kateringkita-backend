import request from "supertest";
import { beforeAll, describe, expect, test } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { createAdmin } from "../src/scripts/create-admin";
import { login, siapkanToko } from "./helpers/toko";

// F27: mode pemeliharaan — admin super menyalakan; penjual & pembeli dapat 503, admin/login/webhook tetap jalan.
let tAdmin: string, tOps: string, tA: string, tCust: string;
const H = (t: string) => ({ Authorization: `Bearer ${t}` });
const nyalakan = (body: object, t = tAdmin) =>
  request(app).put("/api/v1/admin/settings/maintenance").set(H(t)).send(body);

beforeAll(async () => {
  ({ tA, tCust } = await siapkanToko());
  await createAdmin({ phone: "081300000009", fullName: "Admin Uji", password: "rahasia123" });
  await createAdmin({ phone: "081300000008", fullName: "Admin Ops", password: "rahasia123" });
  await db.query("UPDATE users SET admin_level = 'ops' WHERE phone = '081300000008'");
  tAdmin = await login("081300000009");
  tOps = await login("081300000008");
});

describe("mati (bawaan)", () => {
  test("status mati di /meta/settings dan /admin/settings; rute biasa normal", async () => {
    expect((await request(app).get("/api/v1/meta/settings").expect(200)).body.data.maintenance).toEqual({
      aktif: false,
      pesan: null,
    });
    expect((await request(app).get("/api/v1/admin/settings").set(H(tAdmin)).expect(200)).body.data.maintenance).toEqual(
      { aktif: false, pesan: null },
    );
    await request(app).get("/api/v1/menus").expect(200);
    await request(app).get("/api/v1/merchant/profile").set(H(tA)).expect(200);
  });
});

describe("mengubah", () => {
  test("validasi, admin ops ditolak, tanpa token 401", async () => {
    await nyalakan({ aktif: "ya" }).expect(400);
    await nyalakan({ aktif: true, pesan: "x".repeat(201) }).expect(400);
    await nyalakan({ aktif: true }, tOps).expect(403);
    await request(app).put("/api/v1/admin/settings/maintenance").send({ aktif: true }).expect(401);
    expect((await request(app).get("/api/v1/meta/settings")).body.data.maintenance.aktif).toBe(false);
  });

  test("nyala → tercatat di log audit, pesan ikut", async () => {
    const r = await nyalakan({ aktif: true, pesan: "  Pembaruan sistem sampai 14.00 WIB.  " }).expect(200);
    expect(r.body.data).toEqual({ maintenance: { aktif: true, pesan: "Pembaruan sistem sampai 14.00 WIB." } });
    const [log] = await db.query<any[]>("SELECT * FROM admin_audit_logs WHERE action = 'settings.maintenance'");
    expect(log).toHaveLength(1);
    expect((await request(app).get("/api/v1/meta/settings")).body.data.maintenance).toEqual({
      aktif: true,
      pesan: "Pembaruan sistem sampai 14.00 WIB.",
    });
  });
});

describe("saat nyala", () => {
  test("penjual, pembeli, tamu meja, dan katalog publik → 503 MAINTENANCE + Retry-After", async () => {
    const cek = async (r: request.Response) => {
      expect(r.status).toBe(503);
      expect(r.body.error).toMatchObject({ code: "MAINTENANCE", message: "Pembaruan sistem sampai 14.00 WIB." });
      expect(r.headers["retry-after"]).toBe("300");
    };
    await cek(await request(app).get("/api/v1/merchant/profile").set(H(tA)));
    await cek(await request(app).get("/api/v1/Merchant/Profile/").set(H(tA)));
    await cek(await request(app).get("/api/v1/me/orders").set(H(tCust)));
    await cek(await request(app).post("/api/v1/orders").set(H(tCust)).send({}));
    await cek(await request(app).get("/api/v1/menus"));
    await cek(await request(app).get("/api/v1/tables/abc"));
    await cek(await request(app).post("/api/v1/auth/customer/register").send({}));
    await new Promise((r) => setTimeout(r, 200)); // catatLog berjalan setelah respons selesai
    const [[{ n }]] = await db.query<any[]>("SELECT COUNT(*) AS n FROM server_logs WHERE status = 503");
    expect(n).toBe(0);
  });

  test("pengecualian tetap jalan: health, admin, login, /me, ganti sandi, meta/settings, webhook Midtrans", async () => {
    await request(app).get("/api/v1/health").expect(200);
    await request(app).get("/api/v1/admin/summary").set(H(tAdmin)).expect(200);
    expect(
      (
        await request(app)
          .post("/api/v1/auth/login")
          .send({ identifier: "081300000009", password: "rahasia123", client: "web" })
      ).status,
    ).toBe(200);
    await request(app).get("/api/v1/me").set(H(tA)).expect(200);
    expect((await request(app).put("/api/v1/me/password").set(H(tA)).send({})).status).toBe(400);
    await request(app).get("/api/v1/meta/settings").expect(200);
    expect((await request(app).post("/api/v1/payments/midtrans").send({ order_id: "KK-X" })).status).not.toBe(503);
  });

  test("bukan admin tidak bisa lolos lewat path admin", async () => {
    await request(app).get("/api/v1/admin/summary").set(H(tA)).expect(403);
  });

  test("dimatikan → semua normal, pesan kosong = pesan bawaan saat nyala lagi", async () => {
    await nyalakan({ aktif: false }).expect(200);
    await request(app).get("/api/v1/merchant/profile").set(H(tA)).expect(200);
    await nyalakan({ aktif: true, pesan: "" }).expect(200);
    const r = await request(app).get("/api/v1/menus").expect(503);
    expect(r.body.error.message).toBe("KateringKita sedang dalam pemeliharaan. Silakan coba lagi nanti.");
    await nyalakan({ aktif: false }).expect(200);
  });
});
