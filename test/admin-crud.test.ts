import request from "supertest";
import { beforeAll, describe, expect, test } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { createAdmin } from "../src/scripts/create-admin";
import { login, prepareMerchants } from "./helpers/merchant";

// Panel admin: tambah/ubah/nonaktifkan penjual dan pembeli, serta kelola menu toko.
let adminToken: string;
let supportToken: string;
let merchantId: number;
let customerToken: string;
const auth = (token = adminToken) => ({ Authorization: `Bearer ${token}` });
const api = (path: string) => `/api/v1/admin${path}`;
// Status jawaban login (200 berhasil, 401 ditolak); helper login() hanya untuk login yang pasti berhasil.
const loginStatus = async (identifier: string) =>
  (await request(app).post("/api/v1/auth/login").send({ identifier, password: "rahasia123", client: "web" })).status;
const auditActions = async (action: string) =>
  ((await db.query<any[]>("SELECT * FROM admin_audit_logs WHERE action = ? ORDER BY id", [action]))[0] as any[]).length;
const baseMenu = () => ({
  name: "Nasi Ayam",
  category_id: 1,
  description: "Enak",
  image_url: null,
  unit_label: "porsi",
  price: 15000,
  hpp: 9000,
  daily_quota: 20,
  prep_minutes: 15,
  is_preorder: false,
  preorder_days: 0,
  min_order_qty: 1,
  options: [],
});

beforeAll(async () => {
  ({ idA: merchantId, customerToken } = await prepareMerchants());
  await createAdmin({ phone: "081300000009", fullName: "Admin Uji", password: "rahasia123" });
  await createAdmin({ phone: "081300000008", fullName: "Admin Support", password: "rahasia123" });
  await db.query("UPDATE users SET admin_level = 'support' WHERE phone = '081300000008'");
  adminToken = await login("081300000009");
  supportToken = await login("081300000008");
});

describe("penjual", () => {
  test("tambah penjual: toko pending, tercatat; nomor dipakai → 409; support → 403", async () => {
    const body = {
      full_name: "Rina",
      phone: "081255556666",
      email: "rina@mail.com",
      password: "rahasia123",
      business_name: "Dapur Rina",
      merchant_type_id: 1,
      address: "Jl. Melati 2",
    };
    await request(app).post(api("/merchants")).set(auth(supportToken)).send(body).expect(403);
    const created = (await request(app).post(api("/merchants")).set(auth()).send(body).expect(201)).body.data;
    expect(created).toMatchObject({ business_name: "Dapur Rina", verification_status: "pending" });
    expect(created.owner).toMatchObject({ full_name: "Rina", phone: "081255556666", is_active: true });
    expect(await auditActions("merchant.create")).toBe(1);
    expect(await loginStatus("081255556666")).toBe(200);
    await request(app).post(api("/merchants")).set(auth()).send(body).expect(409);
  });

  test("ubah profil toko dan akun pemilik tanpa sandi pemilik", async () => {
    const store = await request(app)
      .patch(api(`/merchants/${merchantId}`))
      .set(auth())
      .send({ business_name: "Dapur Siti Baru", address: "Jl. Kenanga 5" })
      .expect(200);
    expect(store.body.data).toMatchObject({ business_name: "Dapur Siti Baru", address: "Jl. Kenanga 5" });
    const owner = await request(app)
      .patch(api(`/merchants/${merchantId}/owner`))
      .set(auth())
      .send({ full_name: "Siti Aminah", email: "siti.baru@mail.com" })
      .expect(200);
    expect(owner.body.data.owner).toMatchObject({ full_name: "Siti Aminah", email: "siti.baru@mail.com" });
    expect(await auditActions("merchant.store.update")).toBe(1);
    expect(await auditActions("merchant.account.update")).toBe(1);
    // validasi dan id tidak ada
    await request(app)
      .patch(api(`/merchants/${merchantId}/owner`))
      .set(auth())
      .send({})
      .expect(400);
    await request(app)
      .patch(api(`/merchants/${merchantId}/owner`))
      .set(auth())
      .send({ phone: "12" })
      .expect(400);
    await request(app).patch(api("/merchants/99999/owner")).set(auth()).send({ full_name: "X" }).expect(404);
    await request(app).patch(api("/merchants/abc")).set(auth()).send({}).expect(404);
  });

  test("nonaktifkan: pemilik tidak bisa masuk, toko hilang dari katalog; aktifkan lagi memulihkan", async () => {
    await db.query("UPDATE merchants SET verification_status = 'verified' WHERE id = ?", [merchantId]);
    const [[{ slug }]] = await db.query<any[]>("SELECT slug FROM merchants WHERE id = ?", [merchantId]);
    const storeStatus = async () => (await request(app).get(`/api/v1/merchants/${slug}`)).status;
    expect(await storeStatus()).toBe(200);
    const merchantToken = await login("siti.baru@mail.com");
    const off = await request(app)
      .post(api(`/merchants/${merchantId}/account/deactivate`))
      .set(auth())
      .expect(200);
    expect(off.body.data.owner.is_active).toBe(false);
    await request(app).get("/api/v1/me").set(auth(merchantToken)).expect(401);
    expect(await loginStatus("siti.baru@mail.com")).toBe(401);
    expect(await storeStatus()).toBe(404);
    await request(app)
      .post(api(`/merchants/${merchantId}/account/deactivate`))
      .set(auth())
      .expect(409);
    await request(app)
      .post(api(`/merchants/${merchantId}/account/activate`))
      .set(auth())
      .expect(200);
    expect(await loginStatus("siti.baru@mail.com")).toBe(200);
    expect(await storeStatus()).toBe(200);
    expect(await auditActions("merchant.account.deactivate")).toBe(1);
  });
});

describe("menu toko", () => {
  test("tambah, lihat, ubah, hapus menu atas nama toko; tercatat di log toko", async () => {
    const created = (
      await request(app)
        .post(api(`/merchants/${merchantId}/menus`))
        .set(auth())
        .send(baseMenu())
        .expect(201)
    ).body.data;
    expect(created).toMatchObject({ name: "Nasi Ayam", price: 15000 });
    const list = (
      await request(app)
        .get(api(`/merchants/${merchantId}/menus`))
        .set(auth())
        .expect(200)
    ).body.data;
    expect(list.map((menu: any) => menu.id)).toContain(created.id);
    await request(app)
      .get(api(`/merchants/${merchantId}/menus/${created.id}`))
      .set(auth(supportToken))
      .expect(200);
    const updated = await request(app)
      .patch(api(`/merchants/${merchantId}/menus/${created.id}`))
      .set(auth())
      .send({ price: 17000 })
      .expect(200);
    expect(updated.body.data.price).toBe(17000);
    await request(app)
      .delete(api(`/merchants/${merchantId}/menus/${created.id}`))
      .set(auth())
      .expect(204);
    await request(app)
      .get(api(`/merchants/${merchantId}/menus/${created.id}`))
      .set(auth())
      .expect(404);
    expect(await auditActions("menu.create")).toBe(1);
    expect(await auditActions("menu.update")).toBe(1);
    expect(await auditActions("menu.delete")).toBe(1);
    const detail = (
      await request(app)
        .get(api(`/merchants/${merchantId}`))
        .set(auth())
        .expect(200)
    ).body.data;
    expect(detail.recent_logs.map((log: any) => log.action)).toEqual(expect.arrayContaining(["menu.create"]));
  });

  test("aturan menu sama dengan penjual: harga di bawah HPP ditolak; support tidak bisa menambah", async () => {
    await request(app)
      .post(api(`/merchants/${merchantId}/menus`))
      .set(auth())
      .send({ ...baseMenu(), price: 5000 })
      .expect(400);
    await request(app)
      .post(api(`/merchants/${merchantId}/menus`))
      .set(auth(supportToken))
      .send(baseMenu())
      .expect(403);
    await request(app).post(api("/merchants/99999/menus")).set(auth()).send(baseMenu()).expect(404);
  });
});

describe("pembeli", () => {
  test("daftar dengan pencarian dan filter status; detail dengan ringkasan pesanan", async () => {
    const list = (await request(app).get(api("/customers?q=budi")).set(auth(supportToken)).expect(200)).body;
    expect(list.meta.total).toBe(1);
    expect(list.data[0]).toMatchObject({ full_name: "Budi", is_active: true, order_count: 0 });
    await request(app).get(api("/customers?status=x")).set(auth()).expect(400);
    expect((await request(app).get(api("/customers?q=%25")).set(auth()).expect(200)).body.meta.total).toBe(0);
    const detail = (
      await request(app)
        .get(api(`/customers/${list.data[0].id}`))
        .set(auth())
        .expect(200)
    ).body.data;
    expect(detail).toMatchObject({ full_name: "Budi", email_verified: false, orders: { total: 0, spent: 0 } });
    await request(app).get(api("/customers/99999")).set(auth()).expect(404);
    // id penjual bukan pembeli
    const [[seller]] = await db.query<any[]>("SELECT user_id FROM merchants WHERE id = ?", [merchantId]);
    await request(app)
      .get(api(`/customers/${seller.user_id}`))
      .set(auth())
      .expect(404);
  });

  test("tambah, ubah, nonaktifkan, aktifkan pembeli", async () => {
    const body = { full_name: "Dewi", email: "dewi@mail.com", phone: "081277778888", password: "rahasia123" };
    const created = (await request(app).post(api("/customers")).set(auth()).send(body).expect(201)).body.data;
    expect(created).toMatchObject({ full_name: "Dewi", email: "dewi@mail.com", is_active: true });
    await request(app).post(api("/customers")).set(auth()).send(body).expect(409);
    const updated = await request(app)
      .patch(api(`/customers/${created.id}`))
      .set(auth())
      .send({ full_name: "Dewi Lestari" })
      .expect(200);
    expect(updated.body.data.full_name).toBe("Dewi Lestari");
    expect(
      (
        await request(app)
          .patch(api(`/customers/${created.id}`))
          .set(auth())
          .send({ email: "" })
          .expect(400)
      ).body.error.fields.email,
    ).toEqual(["Email wajib diisi."]);
    await request(app)
      .post(api(`/customers/${created.id}/deactivate`))
      .set(auth())
      .expect(200);
    expect(await loginStatus("dewi@mail.com")).toBe(401);
    await request(app)
      .post(api(`/customers/${created.id}/activate`))
      .set(auth())
      .expect(200);
    expect(await loginStatus("dewi@mail.com")).toBe(200);
    await request(app)
      .post(api(`/customers/${created.id}/deactivate`))
      .set(auth(supportToken))
      .expect(403);
    expect(await auditActions("customer.create")).toBe(1);
    expect(await auditActions("customer.account.deactivate")).toBe(1);
  });

  test("pembeli yang dinonaktifkan kehilangan sesinya", async () => {
    const [[budi]] = await db.query<any[]>("SELECT id FROM users WHERE email = 'budi@mail.com'");
    await request(app)
      .post(api(`/customers/${budi.id}/deactivate`))
      .set(auth())
      .expect(200);
    await request(app).get("/api/v1/me").set(auth(customerToken)).expect(401);
  });
});
