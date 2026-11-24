import request from "supertest";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { createAdmin } from "../src/scripts/create-admin";
import { saveAiResult } from "../src/services/ai-result.service";
import { login, prepareMerchants } from "./helpers/merchant";

// Rubrik AI: hasil AI tersimpan tampil di panel admin web dan diverifikasi manual (setujui / tolak + catatan), diaudit.
let setup: Awaited<ReturnType<typeof prepareMerchants>>;
let superToken: string, opsToken: string, supportToken: string, opsId: number, budi: number, siti: number;
const listResults = (query = "", token = superToken) =>
  request(app).get(`/api/v1/admin/hasil-ai${query}`).set("Authorization", `Bearer ${token}`);
const verify = (id: unknown, body: object, token = opsToken) =>
  request(app).patch(`/api/v1/admin/hasil-ai/${id}`).set("Authorization", `Bearer ${token}`).send(body);
const audit = async () =>
  (
    await db.query<any[]>(
      "SELECT admin_user_id, action, target_type, target_id, before_json, after_json FROM admin_audit_logs ORDER BY id",
    )
  )[0] as any[];

beforeAll(async () => {
  setup = await prepareMerchants();
  await createAdmin({ phone: "081300000009", fullName: "Admin Super", password: "rahasia123" });
  opsId = (await createAdmin({ phone: "081300000010", fullName: "Admin Ops", password: "rahasia123" })).id;
  await createAdmin({ phone: "081300000011", fullName: "Admin Support", password: "rahasia123" });
  await db.query("UPDATE users SET admin_level = 'ops' WHERE phone = '081300000010'");
  await db.query("UPDATE users SET admin_level = 'support' WHERE phone = '081300000011'");
  [superToken, opsToken, supportToken] = [
    await login("081300000009"),
    await login("081300000010"),
    await login("081300000011"),
  ];
  const [users] = await db.query<any[]>(
    "SELECT id, email FROM users WHERE email IN ('budi@mail.com', 'siti@mail.com')",
  );
  budi = users.find((user: any) => user.email === "budi@mail.com").id;
  siti = users.find((user: any) => user.email === "siti@mail.com").id;
});
beforeEach(async () => {
  await db.query("DELETE FROM ai_results");
  await db.query("DELETE FROM admin_audit_logs");
});

const seedResults = async () => {
  const assistantId = await saveAiResult({
    feature: "asisten",
    userId: siti,
    merchantId: setup.idA,
    input: "Harga risol [nama]?",
    output: { jawaban: "Rp 6.000", poin: [], asumsi: "" },
  });
  const recommendationId = await saveAiResult({
    feature: "rekomendasi",
    userId: budi,
    input: "nasi goreng",
    output: { summary: "Paket", items: [], total: 0 },
  });
  return { assistantId: assistantId!, recommendationId: recommendationId! };
};

describe("GET /admin/hasil-ai", () => {
  test("terbaru dulu, bentuk lengkap, filter status & fitur, halaman", async () => {
    const { assistantId, recommendationId } = await seedResults();
    const res = await listResults().expect(200);
    expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 2 });
    expect(res.body.data.map((item: any) => item.id)).toEqual([recommendationId, assistantId]);
    expect(res.body.data[1]).toEqual({
      id: assistantId,
      fitur: "asisten",
      input_text: "Harga risol [nama]?",
      output: { jawaban: "Rp 6.000", poin: [], asumsi: "" },
      status: "menunggu",
      catatan: null,
      created_at: expect.any(String),
      verified_at: null,
      verified_by: null,
      user: { id: siti, name: "Siti" },
      merchant: { id: setup.idA, business_name: "Dapur Siti" },
    });
    expect(res.body.data[0]).toMatchObject({ fitur: "rekomendasi", user: { id: budi, name: "Budi" }, merchant: null });
    expect((await listResults("?fitur=rekomendasi").expect(200)).body.data.map((item: any) => item.id)).toEqual([
      recommendationId,
    ]);
    await verify(assistantId, { status: "disetujui" }).expect(200);
    expect((await listResults("?status=menunggu").expect(200)).body.data.map((item: any) => item.id)).toEqual([
      recommendationId,
    ]);
    expect((await listResults("?status=disetujui").expect(200)).body.data.map((item: any) => item.id)).toEqual([
      assistantId,
    ]);
    expect((await listResults("?limit=1&page=2").expect(200)).body).toMatchObject({
      meta: { page: 2, limit: 1, total: 2 },
      data: [{ id: assistantId }],
    });
    expect((await listResults("?status=aneh").expect(400)).body.error.fields.status).toBeDefined();
  });
});

describe("PATCH /admin/hasil-ai/:id", () => {
  test("setujui: status, pemverifikasi, waktu; dicatat di audit", async () => {
    const { assistantId } = await seedResults();
    const res = await verify(assistantId, { status: "disetujui", catatan: "  Angka sesuai data toko  " }).expect(200);
    expect(res.body.data).toMatchObject({
      id: assistantId,
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
        target_id: String(assistantId),
        before_json: { status: "menunggu", catatan: null },
        after_json: { status: "disetujui", catatan: "Angka sesuai data toko" },
      },
    ]);
  });

  test("tolak wajib catatan; keputusan boleh diubah dan tetap diaudit", async () => {
    const { recommendationId } = await seedResults();
    expect((await verify(recommendationId, { status: "ditolak" }).expect(400)).body.error.fields.catatan).toEqual([
      "Tulis alasan penolakan (3–300 karakter).",
    ]);
    await verify(recommendationId, { status: "ditolak", catatan: "Menu tidak sesuai pantangan" }).expect(200);
    await verify(recommendationId, { status: "disetujui" }).expect(200);
    expect((await audit()).map((entry) => [entry.before_json.status, entry.after_json.status])).toEqual([
      ["menunggu", "ditolak"],
      ["ditolak", "disetujui"],
    ]);
  });

  test("validasi & tidak ditemukan", async () => {
    const { assistantId } = await seedResults();
    expect((await verify(assistantId, { status: "menunggu" }).expect(400)).body.error.fields.status).toBeDefined();
    expect(
      (await verify(assistantId, { status: "disetujui", catatan: "x".repeat(301) }).expect(400)).body.error.fields
        .catatan,
    ).toBeDefined();
    await verify(999999, { status: "disetujui" }).expect(404);
    await verify("abc", { status: "disetujui" }).expect(404);
  });

  test("akses: support hanya melihat; penjual & pembeli ditolak", async () => {
    const { assistantId } = await seedResults();
    await listResults("", supportToken).expect(200);
    await verify(assistantId, { status: "disetujui" }, supportToken).expect(403);
    await listResults("", setup.tokenA).expect(403);
    await listResults("", setup.customerToken).expect(403);
    await verify(assistantId, { status: "disetujui" }, superToken).expect(200);
  });
});
