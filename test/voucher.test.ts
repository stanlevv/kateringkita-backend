import request from "supertest";
import { beforeAll, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { createAdmin } from "../src/scripts/create-admin";
import { login, prepareCheckout, makeVisible } from "./helpers/merchant";

// Voucher: tampil di halaman toko, klaim ke Voucher Saya, voucher platform publik, penanda bisa dipakai + alasannya
let setup: Awaited<ReturnType<typeof prepareCheckout>>;
let slugA: string, adminToken: string;
const ids: Record<string, number> = {};
const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });
type PromoOptions = {
  merchant_id?: number | null;
  is_public?: boolean;
  is_active?: boolean;
  type?: string;
  value?: number;
  min_subtotal?: number;
  quota?: number | null;
  used_count?: number;
  per_user_limit?: number;
  mulai?: number;
  akhir?: number;
};
const promo = async (code: string, options: PromoOptions = {}) => {
  const [result] = await db.query<any>(
    `INSERT INTO promos (merchant_id, code, type, value, min_subtotal, quota, used_count, per_user_limit, is_public, is_active, starts_at, ends_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP() + INTERVAL ? HOUR, UTC_TIMESTAMP() + INTERVAL ? HOUR)`,
    [
      options.merchant_id ?? null,
      code,
      options.type ?? "fixed",
      options.value ?? 1000,
      options.min_subtotal ?? 0,
      options.quota ?? null,
      options.used_count ?? 0,
      options.per_user_limit ?? 1,
      options.is_public ?? true,
      options.is_active ?? true,
      options.mulai ?? -24,
      options.akhir ?? 24,
    ],
  );
  ids[code] = result.insertId;
  return result.insertId as number;
};
const klaim = (code: string, token = setup.customerToken) =>
  request(app)
    .post(`/api/v1/me/vouchers/${ids[code] ?? code}/claim`)
    .set(authHeader(token))
    .send();
const saya = (query = "") => request(app).get(`/api/v1/me/vouchers${query}`).set(authHeader(setup.customerToken));

beforeAll(async () => {
  setup = await prepareCheckout();
  vi.restoreAllMocks(); // jam aplikasi = jam nyata, sama dengan UTC_TIMESTAMP() pada tanggal promo uji
  await makeVisible(setup.idB);
  [[{ slug: slugA }]] = (await db.query<any[]>("SELECT slug FROM merchants WHERE id = ?", [setup.idA])) as any;
  await createAdmin({ phone: "081300000009", fullName: "Admin Uji", password: "rahasia123" });
  adminToken = await login("081300000009");
  await promo("PUBLIKA", { merchant_id: setup.idA, type: "percent", value: 10, min_subtotal: 20000, akhir: 48 });
  await promo("HABIS", { merchant_id: setup.idA, quota: 1, used_count: 1, akhir: 24 });
  await promo("RAHASIA", { merchant_id: setup.idA, is_public: false });
  await promo("MATI", { merchant_id: setup.idA, is_active: false });
  await promo("LEWAT", { merchant_id: setup.idA, mulai: -48, akhir: -1 });
  await promo("NANTI", { merchant_id: setup.idA, mulai: 24, akhir: 48 });
  await promo("PUBLIKB", { merchant_id: setup.idB });
  await promo("PLATFORM1", { value: 3000 });
  await promo("PLATRAHASIA", { is_public: false });
});

describe("voucher di halaman toko", () => {
  test("hanya publik, aktif, dalam periode; habis ditandai; tamu claimed false", async () => {
    const vouchers = (await request(app).get(`/api/v1/merchants/${slugA}`).expect(200)).body.data.vouchers;
    expect(vouchers.map((voucher: any) => voucher.code)).toEqual(["HABIS", "PUBLIKA"]); // berakhir paling cepat dulu
    expect(vouchers[1]).toEqual({
      id: ids.PUBLIKA,
      code: "PUBLIKA",
      description: null,
      type: "percent",
      value: 10,
      max_discount: null,
      min_subtotal: 20000,
      starts_at: expect.any(String),
      ends_at: expect.any(String),
      slot: "toko",
      merchant: { id: setup.idA, slug: slugA, business_name: "Dapur Siti" },
      sold_out: false,
      claimed: false,
    });
    expect(vouchers[0].sold_out).toBe(true);
  });
});

describe("klaim", () => {
  test("idempoten; halaman toko menandai claimed untuk pembeli itu", async () => {
    expect((await klaim("PUBLIKA").expect(200)).body.data).toMatchObject({ id: ids.PUBLIKA, claimed: true });
    await klaim("PUBLIKA").expect(200);
    const [[countRow]] = await db.query<any[]>("SELECT COUNT(*) AS n FROM promo_claims WHERE promo_id = ?", [
      ids.PUBLIKA,
    ]);
    expect(Number(countRow.n)).toBe(1);
    const vouchers = (
      await request(app).get(`/api/v1/merchants/${slugA}`).set(authHeader(setup.customerToken)).expect(200)
    ).body.data.vouchers;
    expect(vouchers.find((voucher: any) => voucher.code === "PUBLIKA").claimed).toBe(true);
  });

  test("tidak tersedia 409, kuota habis 409, tidak ada 404, bukan pembeli 403", async () => {
    for (const code of ["RAHASIA", "MATI", "LEWAT", "NANTI", "PLATRAHASIA"]) {
      expect((await klaim(code).expect(409)).body.error.message).toBe("Voucher sedang tidak tersedia.");
    }
    expect((await klaim("HABIS").expect(409)).body.error.message).toBe("Kuota voucher sudah habis.");
    expect((await klaim("999999").expect(404)).body.error.message).toBe("Voucher tidak ditemukan.");
    await klaim("abc").expect(404);
    await klaim("PUBLIKB", setup.tokenA).expect(403);
  });
});

describe("voucher platform & Voucher Saya", () => {
  test("GET /vouchers/platform: hanya platform publik aktif", async () => {
    const vouchers = (await request(app).get("/api/v1/vouchers/platform").expect(200)).body.data;
    expect(vouchers.map((voucher: any) => voucher.code)).toEqual(["PLATFORM1"]);
    expect(vouchers[0]).toMatchObject({ slot: "platform", merchant: null, claimed: false });
  });

  test("Voucher Saya: alasan tidak bisa dipakai sesuai keranjang & metode bayar", async () => {
    await klaim("PLATFORM1").expect(200);
    await klaim("PUBLIKB").expect(200);
    const semua = (await saya().expect(200)).body.data;
    expect(semua.map((voucher: any) => voucher.code).sort()).toEqual(["PLATFORM1", "PUBLIKA", "PUBLIKB"]);
    expect(semua.every((voucher: any) => voucher.usable && voucher.reason === null)).toBe(true);
    const vouchers = (await saya(`?merchant_id=${setup.idA}&subtotal=10000&payment_method=cod`).expect(200)).body.data;
    const alasan = Object.fromEntries(vouchers.map((voucher: any) => [voucher.code, [voucher.usable, voucher.reason]]));
    expect(alasan).toEqual({
      PUBLIKA: [false, "Minimal belanja Rp 20.000"],
      PUBLIKB: [false, "Khusus Dapur Andi"],
      PLATFORM1: [false, "Voucher platform hanya untuk bayar non-tunai."],
    });
    const usable = (await saya(`?merchant_id=${setup.idA}&subtotal=30000&payment_method=va`).expect(200)).body.data;
    expect(
      usable
        .filter((voucher: any) => voucher.usable)
        .map((voucher: any) => voucher.code)
        .sort(),
    ).toEqual(["PLATFORM1", "PUBLIKA"]);
    expect((await saya("?subtotal=abc").expect(400)).body.error.fields.subtotal).toBeDefined();
  });

  test("klaim yang sudah berakhir tetap tampil sebagai tidak bisa dipakai", async () => {
    await db.query("UPDATE promos SET ends_at = UTC_TIMESTAMP() - INTERVAL 1 HOUR WHERE id = ?", [ids.PUBLIKB]);
    const voucher = (await saya().expect(200)).body.data.find((item: any) => item.code === "PUBLIKB");
    expect([voucher.usable, voucher.reason]).toEqual([false, "Voucher sudah berakhir."]);
  });
});

describe("pengaturan promo", () => {
  test("promo toko lama gratis biaya layanan tetap bisa diubah selama jenisnya tidak diganti (C2)", async () => {
    const [result] = await db.query<any>(
      `INSERT INTO promos (merchant_id, code, type, value, starts_at, ends_at)
       VALUES (?, 'LAMAGRATIS', 'free_service_fee', 0, UTC_TIMESTAMP() - INTERVAL 1 DAY, UTC_TIMESTAMP() + INTERVAL 5 DAY)`,
      [setup.idA],
    );
    const res = await request(app)
      .patch(`/api/v1/merchant/promos/${result.insertId}`)
      .set(authHeader(setup.tokenA))
      .send({ type: "free_service_fee", is_public: false, ends_at: "2099-01-01T00:00:00Z" })
      .expect(200);
    expect(res.body.data).toMatchObject({ type: "free_service_fee", is_public: false });
  });

  test("promo toko: tanpa gratis biaya layanan (C2); is_public bisa dimatikan", async () => {
    const isi = {
      type: "fixed",
      value: 1000,
      min_subtotal: 0,
      per_user_limit: 1,
      starts_at: "2020-01-01T00:00:00Z",
      ends_at: "2099-01-01T00:00:00Z",
    };
    const res = await request(app)
      .post("/api/v1/merchant/promos")
      .set(authHeader(setup.tokenA))
      .send({ ...isi, code: "GRATISTOKO", type: "free_service_fee" })
      .expect(400);
    expect(res.body.error.fields.type).toEqual(["Promo toko hanya potongan persen atau nominal."]);
    const okRes = await request(app)
      .post("/api/v1/merchant/promos")
      .set(authHeader(setup.tokenA))
      .send({ ...isi, code: "TOKOBARU" })
      .expect(201);
    expect(okRes.body.data.is_public).toBe(true);
    await request(app)
      .patch(`/api/v1/merchant/promos/${okRes.body.data.id}`)
      .set(authHeader(setup.tokenA))
      .send({ type: "free_service_fee" })
      .expect(400);
    const patchRes = await request(app)
      .patch(`/api/v1/merchant/promos/${okRes.body.data.id}`)
      .set(authHeader(setup.tokenA))
      .send({ is_public: false })
      .expect(200);
    expect(patchRes.body.data.is_public).toBe(false);
    const vouchers = (await request(app).get(`/api/v1/merchants/${slugA}`).expect(200)).body.data.vouchers;
    expect(vouchers.map((voucher: any) => voucher.code)).not.toContain("TOKOBARU");
  });

  test("promo platform admin: is_public bisa diatur, gratis biaya layanan tetap boleh", async () => {
    const isi = {
      code: "ADMINGRATIS",
      type: "free_service_fee",
      value: 0,
      min_subtotal: 0,
      per_user_limit: 1,
      starts_at: "2020-01-01T00:00:00Z",
      ends_at: "2099-01-01T00:00:00Z",
    };
    const res = await request(app)
      .post("/api/v1/admin/promos")
      .set(authHeader(adminToken))
      .send({ ...isi, is_public: false })
      .expect(201);
    expect(res.body.data.is_public).toBe(false);
    const patchRes = await request(app)
      .patch(`/api/v1/admin/promos/${res.body.data.id}`)
      .set(authHeader(adminToken))
      .send({ is_public: true })
      .expect(200);
    expect(patchRes.body.data.is_public).toBe(true);
  });
});
