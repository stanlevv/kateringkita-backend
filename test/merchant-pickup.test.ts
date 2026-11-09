import request from "supertest";
import { beforeEach, expect, test } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { migrate } from "../src/scripts/migrate";
import { createAdmin } from "../src/scripts/create-admin";
import { loginLimiter } from "../src/middleware/rateLimiter";
import { resetTestDatabase } from "./helpers/db";

let tA: string, tAdmin: string;
let idA: number, idB: number;

const login = async (identifier: string) =>
  (await request(app).post("/api/v1/auth/login").send({ identifier, password: "rahasia123", client: "web" })).body.data.token as string;
const regMerchant = (name: string, phone: string, email: string) =>
  request(app).post("/api/v1/auth/merchant/register").send({
    full_name: name, email, phone, password: "rahasia123", business_name: `Dapur ${name}`, merchant_type_id: 1, address: "Jl. Mawar 1",
  }).expect(201);
const patch = (b: object) => request(app).patch("/api/v1/merchant/profile").set("Authorization", `Bearer ${tA}`).send(b);
const links = async (id: number) =>
  ((await db.query<any[]>("SELECT pickup_point_id p FROM merchant_pickup_points WHERE merchant_id=? ORDER BY 1", [id]))[0] as any[]).map((r) => r.p);
const admin = (r: request.Test) => r.set("Authorization", `Bearer ${tAdmin}`);

beforeEach(async () => {
  await migrate(await resetTestDatabase());
  loginLimiter.reset();
  await regMerchant("Siti", "081298765432", "siti@mail.com");
  await regMerchant("Andi", "081211112222", "andi@mail.com");
  await createAdmin({ phone: "081300000009", fullName: "Admin Uji", password: "rahasia123" });
  tA = await login("siti@mail.com");
  tAdmin = await login("081300000009");
  const [rows] = await db.query<any[]>("SELECT id FROM merchants ORDER BY id");
  idA = rows[0].id;
  idB = rows[1].id;
});

test("pengganti penuh, duplikat dibuang, urut naik", async () => {
  expect((await patch({ pickup_point_ids: [3, 1, 1] }).expect(200)).body.data.pickup_point_ids).toEqual([1, 3]);
  expect((await patch({ pickup_point_ids: [2] }).expect(200)).body.data.pickup_point_ids).toEqual([2]);
  expect(await links(idA)).toEqual([2]);
});

test("kosong / tak ada / nonaktif → 400 dan set lama utuh (transaksi)", async () => {
  await patch({ pickup_point_ids: [2] }).expect(200);
  await db.query("INSERT INTO merchant_pickup_points (merchant_id, pickup_point_id) VALUES (?, 1)", [idB]);
  await db.query("UPDATE pickup_points SET is_active = FALSE WHERE id = 3");
  const cases: [number[], string][] = [[[], "Pilih minimal satu titik temu."], [[99], "Titik temu tidak tersedia."], [[1, 3], "Titik temu tidak tersedia."]];
  for (const [ids, msg] of cases) {
    const r = await patch({ pickup_point_ids: ids, business_name: "Tidak Tersimpan" }).expect(400);
    expect(r.body.error.fields.pickup_point_ids).toEqual([msg]);
    expect(await links(idA)).toEqual([2]);
    expect(((await db.query<any[]>("SELECT business_name n FROM merchants WHERE id=?", [idA]))[0] as any[])[0].n).toBe("Dapur Siti");
  }
  expect(await links(idB)).toEqual([1]);
});

test("pickup_point_ids bersama kolom lain tersimpan dalam satu permintaan", async () => {
  const r = await patch({ pickup_point_ids: [1], business_name: "Gabungan" }).expect(200);
  expect(r.body.data).toMatchObject({ business_name: "Gabungan", pickup_point_ids: [1] });
});

test("GET tidak memuat titik nonaktif", async () => {
  await patch({ pickup_point_ids: [1, 2] }).expect(200);
  await db.query("UPDATE pickup_points SET is_active = FALSE WHERE id = 2");
  const r = await request(app).get("/api/v1/merchant/profile").set("Authorization", `Bearer ${tA}`);
  expect(r.body.data.pickup_point_ids).toEqual([1]);
  expect(await links(idA)).toEqual([1, 2]);
});

test("Review Focus 5: toggle status tidak, ganti titik temu ya → updated_after_note", async () => {
  await admin(request(app).post(`/api/v1/admin/merchants/${idA}/request-fix`).send({ reason: "Lengkapi" })).expect(200);
  await db.query("UPDATE admin_audit_logs SET created_at = DATE_SUB(created_at, INTERVAL 1 MINUTE)");
  await db.query("UPDATE merchants SET updated_at = DATE_SUB((SELECT MIN(created_at) FROM admin_audit_logs), INTERVAL 1 MINUTE) WHERE id = ?", [idA]);
  const note = async () => (await admin(request(app).get("/api/v1/admin/verification-queue"))).body.data.find((m: any) => m.id === idA).updated_after_note;
  await request(app).patch("/api/v1/merchant/status").set("Authorization", `Bearer ${tA}`).send({ is_open: false }).expect(200);
  expect(await note()).toBe(false);
  await patch({ pickup_point_ids: [1] }).expect(200);
  expect(await note()).toBe(true);
});

test("admin tetap tak bisa menonaktifkan titik temu terakhir toko terverifikasi (409)", async () => {
  await patch({ pickup_point_ids: [1] }).expect(200);
  await admin(request(app).post(`/api/v1/admin/merchants/${idA}/verify`)).expect(200);
  await admin(request(app).post("/api/v1/admin/master/pickup-points/1/deactivate")).expect(409);
});

test("simpan ulang titik temu yang sama tidak menggeser updated_at", async () => {
  await patch({ pickup_point_ids: [1, 2] }).expect(200);
  await db.query("UPDATE merchants SET updated_at = '2026-01-01 00:00:00' WHERE id = ?", [idA]);
  await patch({ pickup_point_ids: [2, 1, 1] }).expect(200);
  const u = async () => ((await db.query<any[]>("SELECT DATE_FORMAT(updated_at, '%Y-%m-%d') u FROM merchants WHERE id=?", [idA]))[0] as any[])[0].u;
  expect(await u()).toBe("2026-01-01");
  await patch({ pickup_point_ids: [1] }).expect(200);
  expect(await u()).not.toBe("2026-01-01");
});

test("tipe salah → pesan Indonesia, bukan teks bawaan", async () => {
  const f = async (b: object) => (await patch(b).expect(400)).body.error.fields;
  expect((await f({ business_name: 5 })).business_name[0]).toBe("Nama usaha wajib diisi.");
  expect((await f({ wa_template: 5 })).wa_template[0]).toBe("Templat tidak boleh kosong.");
  expect((await f({ wa_number: 5 })).wa_number[0]).toBe("Nomor WA harus diawali 08 dan 10–13 digit.");
  expect((await f({ description: null })).description[0]).toBe("Deskripsi harus berupa teks.");
  expect((await f({ pickup_point_ids: ["a"] })).pickup_point_ids).toEqual(["Titik temu tidak tersedia."]);
  expect((await f({ pickup_point_ids: "1" })).pickup_point_ids).toEqual(["Pilih minimal satu titik temu."]);
  expect((await f({ pickup_point_ids: Array.from({ length: 51 }, (_, i) => i + 1) })).pickup_point_ids).toEqual(["Maksimal 50 titik temu."]);
});

test("admin menonaktifkan titik temu saat penjual menambahkannya bersamaan → 409, tidak terlewat", { timeout: 15000 }, async () => {
  await db.query("UPDATE merchants SET verification_status = 'verified' WHERE id = ?", [idA]);
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("SELECT id FROM merchants WHERE id = ? FOR UPDATE", [idA]);
    await conn.query("SELECT id FROM pickup_points WHERE id = 3 AND is_active FOR UPDATE"); // sama dengan merchant.service
    await conn.query("INSERT INTO merchant_pickup_points (merchant_id, pickup_point_id) VALUES (?, 3)", [idA]);
    const pending = Promise.resolve(admin(request(app).post("/api/v1/admin/master/pickup-points/3/deactivate")).then((r) => r));
    for (let i = 0; i < 100; i++) {
      // innodb_trx tidak menampilkan transaksi admin yang menunggu di sini; data_lock_waits andal (TiDB: di information_schema)
      const tabel = process.env.DATABASE_URL?.includes("tidbcloud.com") ? "information_schema" : "performance_schema";
      const [w] = await db.query<any[]>(`SELECT COUNT(*) AS n FROM ${tabel}.data_lock_waits`);
      if (Number(w[0].n) > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await conn.commit();
    const r = await pending;
    expect(r.status).toBe(409);
    expect(r.body.error.message).toBe("Data titik temu berubah. Coba lagi.");
  } finally {
    conn.release();
  }
  expect(((await db.query<any[]>("SELECT is_active a FROM pickup_points WHERE id=3"))[0] as any[])[0].a).toBe(1);
});

test("updated_at: edit kolom saat titik temu sama tetap menggeser; simpan ulang titik temu saja tidak", async () => {
  await patch({ pickup_point_ids: [1] }).expect(200);
  await admin(request(app).post(`/api/v1/admin/merchants/${idA}/request-fix`).send({ reason: "Lengkapi" })).expect(200);
  await db.query("UPDATE admin_audit_logs SET created_at = DATE_SUB(created_at, INTERVAL 1 MINUTE)");
  const mundur = () => db.query("UPDATE merchants SET updated_at = DATE_SUB((SELECT MIN(created_at) FROM admin_audit_logs), INTERVAL 1 MINUTE) WHERE id = ?", [idA]);
  const note = async () => (await admin(request(app).get("/api/v1/admin/verification-queue"))).body.data.find((m: any) => m.id === idA).updated_after_note;
  await mundur();
  await patch({ pickup_point_ids: [1] }).expect(200);
  expect(await note()).toBe(false);
  await patch({ business_name: "Nama Baru", pickup_point_ids: [1] }).expect(200);
  expect(await note()).toBe(true);
  await mundur();
  await patch({ address: "Jl. Baru 9" }).expect(200);
  expect(await note()).toBe(true);
});

test("jam tersimpan tidak valid (via SQL) tidak menghalangi simpan field lain", async () => {
  await db.query("UPDATE merchants SET open_time = '16:00', close_time = '08:00' WHERE id = ?", [idA]);
  await patch({ wa_template: "Halo {nama}" }).expect(200);
  await patch({ open_time: "17:00" }).expect(400);
});

test("checklist admin: titik temu nonaktif tidak dihitung", async () => {
  await patch({ pickup_point_ids: [2] }).expect(200);
  const cek = async () => (await admin(request(app).get(`/api/v1/admin/merchants/${idA}`))).body.data.checklist.pickup_point;
  expect(await cek()).toBe(true);
  await db.query("UPDATE pickup_points SET is_active = FALSE WHERE id = 2");
  expect(await cek()).toBe(false);
});

test("ganti sebagian titik temu: yang dipertahankan tetap, selisih saja berubah", async () => {
  await patch({ pickup_point_ids: [1, 2] }).expect(200);
  expect((await patch({ pickup_point_ids: [2, 3] }).expect(200)).body.data.pickup_point_ids).toEqual([2, 3]);
  expect(await links(idA)).toEqual([2, 3]);
});
