import request from "supertest";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { createAdmin } from "../src/scripts/create-admin";
import { simpanHasil } from "../src/services/ai-result.service";
import { login, prepareMerchants } from "./helpers/merchant";

// Rubrik AI: hasil AI tersimpan tampil di panel admin web dan diverifikasi manual (setujui / tolak + catatan), diaudit.
let s: Awaited<ReturnType<typeof prepareMerchants>>;
let tSuper: string, tOps: string, tSupport: string, opsId: number, budi: number, siti: number;
const daftar = (q = "", t = tSuper) =>
  request(app).get(`/api/v1/admin/hasil-ai${q}`).set("Authorization", `Bearer ${t}`);
const verif = (id: unknown, body: object, t = tOps) =>
  request(app).patch(`/api/v1/admin/hasil-ai/${id}`).set("Authorization", `Bearer ${t}`).send(body);
const audit = async () =>
  (
    await db.query<any[]>(
      "SELECT admin_user_id, action, target_type, target_id, before_json, after_json FROM admin_audit_logs ORDER BY id",
    )
  )[0] as any[];

beforeAll(async () => {
  s = await prepareMerchants();
  await createAdmin({ phone: "081300000009", fullName: "Admin Super", password: "rahasia123" });
  opsId = (await createAdmin({ phone: "081300000010", fullName: "Admin Ops", password: "rahasia123" })).id;
  await createAdmin({ phone: "081300000011", fullName: "Admin Support", password: "rahasia123" });
  await db.query("UPDATE users SET admin_level = 'ops' WHERE phone = '081300000010'");
  await db.query("UPDATE users SET admin_level = 'support' WHERE phone = '081300000011'");
  [tSuper, tOps, tSupport] = [await login("081300000009"), await login("081300000010"), await login("081300000011")];
  const [u] = await db.query<any[]>("SELECT id, email FROM users WHERE email IN ('budi@mail.com', 'siti@mail.com')");
  budi = u.find((r: any) => r.email === "budi@mail.com").id;
  siti = u.find((r: any) => r.email === "siti@mail.com").id;
});
beforeEach(async () => {
  await db.query("DELETE FROM ai_results");
  await db.query("DELETE FROM admin_audit_logs");
});

const isi = async () => {
  const a = await simpanHasil({
    fitur: "asisten",
    userId: siti,
    merchantId: s.idA,
    input: "Harga risol [nama]?",
    output: { jawaban: "Rp 6.000", poin: [], asumsi: "" },
  });
  const b = await simpanHasil({
    fitur: "rekomendasi",
    userId: budi,
    input: "nasi goreng",
    output: { summary: "Paket", items: [], total: 0 },
  });
  return { a: a!, b: b! };
};

describe("GET /admin/hasil-ai", () => {
  test("terbaru dulu, bentuk lengkap, filter status & fitur, halaman", async () => {
    const { a, b } = await isi();
    const r = await daftar().expect(200);
    expect(r.body.meta).toEqual({ page: 1, limit: 20, total: 2 });
    expect(r.body.data.map((x: any) => x.id)).toEqual([b, a]);
    expect(r.body.data[1]).toEqual({
      id: a,
      fitur: "asisten",
      input_text: "Harga risol [nama]?",
      output: { jawaban: "Rp 6.000", poin: [], asumsi: "" },
      status: "menunggu",
      catatan: null,
      created_at: expect.any(String),
      verified_at: null,
      verified_by: null,
      user: { id: siti, name: "Siti" },
      merchant: { id: s.idA, business_name: "Dapur Siti" },
    });
    expect(r.body.data[0]).toMatchObject({ fitur: "rekomendasi", user: { id: budi, name: "Budi" }, merchant: null });
    expect((await daftar("?fitur=rekomendasi").expect(200)).body.data.map((x: any) => x.id)).toEqual([b]);
    await verif(a, { status: "disetujui" }).expect(200);
    expect((await daftar("?status=menunggu").expect(200)).body.data.map((x: any) => x.id)).toEqual([b]);
    expect((await daftar("?status=disetujui").expect(200)).body.data.map((x: any) => x.id)).toEqual([a]);
    expect((await daftar("?limit=1&page=2").expect(200)).body).toMatchObject({
      meta: { page: 2, limit: 1, total: 2 },
      data: [{ id: a }],
    });
    expect((await daftar("?status=aneh").expect(400)).body.error.fields.status).toBeDefined();
  });
});

describe("PATCH /admin/hasil-ai/:id", () => {
  test("setujui: status, pemverifikasi, waktu; dicatat di audit", async () => {
    const { a } = await isi();
    const r = await verif(a, { status: "disetujui", catatan: "  Angka sesuai data toko  " }).expect(200);
    expect(r.body.data).toMatchObject({
      id: a,
      status: "disetujui",
      catatan: "Angka sesuai data toko",
      verified_by: { id: opsId, name: "Admin Ops" },
      verified_at: expect.any(String),
    });
    expect(await audit()).toEqual([
      {
        admin_user_id: opsId,
        action: "ai_result.verify",
        target_type: "ai_result",
        target_id: String(a),
        before_json: { status: "menunggu", catatan: null },
        after_json: { status: "disetujui", catatan: "Angka sesuai data toko" },
      },
    ]);
  });

  test("tolak wajib catatan; keputusan boleh diubah dan tetap diaudit", async () => {
    const { b } = await isi();
    expect((await verif(b, { status: "ditolak" }).expect(400)).body.error.fields.catatan).toEqual([
      "Tulis alasan penolakan (3–300 karakter).",
    ]);
    await verif(b, { status: "ditolak", catatan: "Menu tidak sesuai pantangan" }).expect(200);
    await verif(b, { status: "disetujui" }).expect(200);
    expect((await audit()).map((x) => [x.before_json.status, x.after_json.status])).toEqual([
      ["menunggu", "ditolak"],
      ["ditolak", "disetujui"],
    ]);
  });

  test("validasi & tidak ditemukan", async () => {
    const { a } = await isi();
    expect((await verif(a, { status: "menunggu" }).expect(400)).body.error.fields.status).toBeDefined();
    expect(
      (await verif(a, { status: "disetujui", catatan: "x".repeat(301) }).expect(400)).body.error.fields.catatan,
    ).toBeDefined();
    await verif(999999, { status: "disetujui" }).expect(404);
    await verif("abc", { status: "disetujui" }).expect(404);
  });

  test("akses: support hanya melihat; penjual & pembeli ditolak", async () => {
    const { a } = await isi();
    await daftar("", tSupport).expect(200);
    await verif(a, { status: "disetujui" }, tSupport).expect(403);
    await daftar("", s.tokenA).expect(403);
    await daftar("", s.customerToken).expect(403);
    await verif(a, { status: "disetujui" }, tSuper).expect(200);
  });
});
