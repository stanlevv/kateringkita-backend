import request from "supertest";
import { beforeAll, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { createAdmin } from "../src/scripts/create-admin";
import { login, siapCheckout, tampilkan } from "./helpers/toko";

// Voucher: tampil di halaman toko, klaim ke Voucher Saya, voucher platform publik, penanda bisa dipakai + alasannya
let s: Awaited<ReturnType<typeof siapCheckout>>;
let slugA: string, tAdmin: string;
const ids: Record<string, number> = {};
const H = (t: string) => ({ Authorization: `Bearer ${t}` });
type P = { merchant_id?: number | null; is_public?: boolean; is_active?: boolean; type?: string; value?: number; min_subtotal?: number;
  quota?: number | null; used_count?: number; per_user_limit?: number; mulai?: number; akhir?: number };
const promo = async (code: string, p: P = {}) => {
  const [r] = await db.query<any>(
    `INSERT INTO promos (merchant_id, code, type, value, min_subtotal, quota, used_count, per_user_limit, is_public, is_active, starts_at, ends_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP() + INTERVAL ? HOUR, UTC_TIMESTAMP() + INTERVAL ? HOUR)`,
    [p.merchant_id ?? null, code, p.type ?? "fixed", p.value ?? 1000, p.min_subtotal ?? 0, p.quota ?? null, p.used_count ?? 0,
      p.per_user_limit ?? 1, p.is_public ?? true, p.is_active ?? true, p.mulai ?? -24, p.akhir ?? 24],
  );
  ids[code] = r.insertId;
  return r.insertId as number;
};
const klaim = (code: string, t = s.tCust) => request(app).post(`/api/v1/me/vouchers/${ids[code] ?? code}/claim`).set(H(t)).send();
const saya = (q = "") => request(app).get(`/api/v1/me/vouchers${q}`).set(H(s.tCust));

beforeAll(async () => {
  s = await siapCheckout();
  vi.restoreAllMocks(); // jam aplikasi = jam nyata, sama dengan UTC_TIMESTAMP() pada tanggal promo uji
  await tampilkan(s.idB);
  [[{ slug: slugA }]] = (await db.query<any[]>("SELECT slug FROM merchants WHERE id = ?", [s.idA])) as any;
  await createAdmin({ phone: "081300000009", fullName: "Admin Uji", password: "rahasia123" });
  tAdmin = await login("081300000009");
  await promo("PUBLIKA", { merchant_id: s.idA, type: "percent", value: 10, min_subtotal: 20000, akhir: 48 });
  await promo("HABIS", { merchant_id: s.idA, quota: 1, used_count: 1, akhir: 24 });
  await promo("RAHASIA", { merchant_id: s.idA, is_public: false });
  await promo("MATI", { merchant_id: s.idA, is_active: false });
  await promo("LEWAT", { merchant_id: s.idA, mulai: -48, akhir: -1 });
  await promo("NANTI", { merchant_id: s.idA, mulai: 24, akhir: 48 });
  await promo("PUBLIKB", { merchant_id: s.idB });
  await promo("PLATFORM1", { value: 3000 });
  await promo("PLATRAHASIA", { is_public: false });
});

describe("voucher di halaman toko", () => {
  test("hanya publik, aktif, dalam periode; habis ditandai; tamu claimed false", async () => {
    const v = (await request(app).get(`/api/v1/merchants/${slugA}`).expect(200)).body.data.vouchers;
    expect(v.map((x: any) => x.code)).toEqual(["HABIS", "PUBLIKA"]); // berakhir paling cepat dulu
    expect(v[1]).toEqual({
      id: ids.PUBLIKA, code: "PUBLIKA", description: null, type: "percent", value: 10, max_discount: null, min_subtotal: 20000,
      starts_at: expect.any(String), ends_at: expect.any(String), slot: "toko",
      merchant: { id: s.idA, slug: slugA, business_name: "Dapur Siti" }, sold_out: false, claimed: false,
    });
    expect(v[0].sold_out).toBe(true);
  });
});

describe("klaim", () => {
  test("idempoten; halaman toko menandai claimed untuk pembeli itu", async () => {
    expect((await klaim("PUBLIKA").expect(200)).body.data).toMatchObject({ id: ids.PUBLIKA, claimed: true });
    await klaim("PUBLIKA").expect(200);
    const [[n]] = await db.query<any[]>("SELECT COUNT(*) AS n FROM promo_claims WHERE promo_id = ?", [ids.PUBLIKA]);
    expect(Number(n.n)).toBe(1);
    const v = (await request(app).get(`/api/v1/merchants/${slugA}`).set(H(s.tCust)).expect(200)).body.data.vouchers;
    expect(v.find((x: any) => x.code === "PUBLIKA").claimed).toBe(true);
  });

  test("tidak tersedia 409, kuota habis 409, tidak ada 404, bukan pembeli 403", async () => {
    for (const c of ["RAHASIA", "MATI", "LEWAT", "NANTI", "PLATRAHASIA"]) {
      expect((await klaim(c).expect(409)).body.error.message).toBe("Voucher sedang tidak tersedia.");
    }
    expect((await klaim("HABIS").expect(409)).body.error.message).toBe("Kuota voucher sudah habis.");
    expect((await klaim("999999").expect(404)).body.error.message).toBe("Voucher tidak ditemukan.");
    await klaim("abc").expect(404);
    await klaim("PUBLIKB", s.tA).expect(403);
  });
});

describe("voucher platform & Voucher Saya", () => {
  test("GET /vouchers/platform: hanya platform publik aktif", async () => {
    const v = (await request(app).get("/api/v1/vouchers/platform").expect(200)).body.data;
    expect(v.map((x: any) => x.code)).toEqual(["PLATFORM1"]);
    expect(v[0]).toMatchObject({ slot: "platform", merchant: null, claimed: false });
  });

  test("Voucher Saya: alasan tidak bisa dipakai sesuai keranjang & metode bayar", async () => {
    await klaim("PLATFORM1").expect(200);
    await klaim("PUBLIKB").expect(200);
    const semua = (await saya().expect(200)).body.data;
    expect(semua.map((x: any) => x.code).sort()).toEqual(["PLATFORM1", "PUBLIKA", "PUBLIKB"]);
    expect(semua.every((x: any) => x.usable && x.reason === null)).toBe(true);
    const r = (await saya(`?merchant_id=${s.idA}&subtotal=10000&payment_method=cod`).expect(200)).body.data;
    const alasan = Object.fromEntries(r.map((x: any) => [x.code, [x.usable, x.reason]]));
    expect(alasan).toEqual({
      PUBLIKA: [false, "Minimal belanja Rp 20.000"],
      PUBLIKB: [false, "Khusus Dapur Andi"],
      PLATFORM1: [false, "Voucher platform hanya untuk bayar non-tunai."],
    });
    const ok = (await saya(`?merchant_id=${s.idA}&subtotal=30000&payment_method=va`).expect(200)).body.data;
    expect(ok.filter((x: any) => x.usable).map((x: any) => x.code).sort()).toEqual(["PLATFORM1", "PUBLIKA"]);
    expect((await saya("?subtotal=abc").expect(400)).body.error.fields.subtotal).toBeDefined();
  });

  test("klaim yang sudah berakhir tetap tampil sebagai tidak bisa dipakai", async () => {
    await db.query("UPDATE promos SET ends_at = UTC_TIMESTAMP() - INTERVAL 1 HOUR WHERE id = ?", [ids.PUBLIKB]);
    const x = (await saya().expect(200)).body.data.find((v: any) => v.code === "PUBLIKB");
    expect([x.usable, x.reason]).toEqual([false, "Voucher sudah berakhir."]);
  });
});

describe("pengaturan promo", () => {
  test("promo toko lama gratis biaya layanan tetap bisa diubah selama jenisnya tidak diganti (C2)", async () => {
    const [r] = await db.query<any>(
      `INSERT INTO promos (merchant_id, code, type, value, starts_at, ends_at)
       VALUES (?, 'LAMAGRATIS', 'free_service_fee', 0, UTC_TIMESTAMP() - INTERVAL 1 DAY, UTC_TIMESTAMP() + INTERVAL 5 DAY)`, [s.idA],
    );
    const p = await request(app).patch(`/api/v1/merchant/promos/${r.insertId}`).set(H(s.tA))
      .send({ type: "free_service_fee", is_public: false, ends_at: "2099-01-01T00:00:00Z" }).expect(200);
    expect(p.body.data).toMatchObject({ type: "free_service_fee", is_public: false });
  });

  test("promo toko: tanpa gratis biaya layanan (C2); is_public bisa dimatikan", async () => {
    const isi = { type: "fixed", value: 1000, min_subtotal: 0, per_user_limit: 1, starts_at: "2020-01-01T00:00:00Z", ends_at: "2099-01-01T00:00:00Z" };
    const r = await request(app).post("/api/v1/merchant/promos").set(H(s.tA)).send({ ...isi, code: "GRATISTOKO", type: "free_service_fee" }).expect(400);
    expect(r.body.error.fields.type).toEqual(["Promo toko hanya potongan persen atau nominal."]);
    const ok = await request(app).post("/api/v1/merchant/promos").set(H(s.tA)).send({ ...isi, code: "TOKOBARU" }).expect(201);
    expect(ok.body.data.is_public).toBe(true);
    await request(app).patch(`/api/v1/merchant/promos/${ok.body.data.id}`).set(H(s.tA)).send({ type: "free_service_fee" }).expect(400);
    const p = await request(app).patch(`/api/v1/merchant/promos/${ok.body.data.id}`).set(H(s.tA)).send({ is_public: false }).expect(200);
    expect(p.body.data.is_public).toBe(false);
    const v = (await request(app).get(`/api/v1/merchants/${slugA}`).expect(200)).body.data.vouchers;
    expect(v.map((x: any) => x.code)).not.toContain("TOKOBARU");
  });

  test("promo platform admin: is_public bisa diatur, gratis biaya layanan tetap boleh", async () => {
    const isi = { code: "ADMINGRATIS", type: "free_service_fee", value: 0, min_subtotal: 0, per_user_limit: 1, starts_at: "2020-01-01T00:00:00Z", ends_at: "2099-01-01T00:00:00Z" };
    const r = await request(app).post("/api/v1/admin/promos").set(H(tAdmin)).send({ ...isi, is_public: false }).expect(201);
    expect(r.body.data.is_public).toBe(false);
    const p = await request(app).patch(`/api/v1/admin/promos/${r.body.data.id}`).set(H(tAdmin)).send({ is_public: true }).expect(200);
    expect(p.body.data.is_public).toBe(true);
  });
});
