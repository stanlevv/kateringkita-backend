import request from "supertest";
import { beforeAll, expect, test } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { migrate } from "../src/scripts/migrate";
import { createAdmin } from "../src/scripts/create-admin";
import { loginLimiter } from "../src/middleware/rateLimiter";
import { resetTestDatabase } from "./helpers/db";

let token: string;
const A = () => ({ Authorization: `Bearer ${token}` });
const get = (u: string) => request(app).get(`/api/v1/admin${u}`).set(A());
const post = (u: string, b: object = {}) => request(app).post(`/api/v1/admin${u}`).set(A()).send(b);
const patch = (u: string, b: object = {}) => request(app).patch(`/api/v1/admin${u}`).set(A()).send(b);
const logs = async (like = "master.%") => (await db.query<any[]>("SELECT * FROM admin_audit_logs WHERE action LIKE ? ORDER BY id", [like]))[0] as any[];

beforeAll(async () => {
  await migrate(await resetTestDatabase());
  loginLimiter.reset();
  await createAdmin({ phone: "081300000009", fullName: "Admin Uji", password: "rahasia123" });
  token = (await request(app).post("/api/v1/auth/login").send({ identifier: "081300000009", password: "rahasia123", client: "web" })).body.data.token;
});

test("kind tak dikenal → 404", async () => {
  await get("/master/foo").expect(404);
  await post("/master/foo", { name: "x" }).expect(404);
});

test("kategori: slug otomatis, tabrakan slug, nama duplikat 409, slug tetap saat rename", async () => {
  const a = await post("/master/categories", { name: "  Nasi Kotak ", icon: "box" }).expect(201);
  expect(a.body.data).toMatchObject({ name: "Nasi Kotak", slug: "nasi-kotak", icon: "box" });
  expect(Boolean(a.body.data.is_active)).toBe(true);
  const b = await post("/master/categories", { name: "Nasi  Kotak!" }).expect(201);
  expect(b.body.data.slug).toBe("nasi-kotak-2");
  const dup = await post("/master/categories", { name: "Nasi Kotak" }).expect(409);
  expect(dup.body.error).toMatchObject({ code: "CONFLICT", message: "Nama sudah dipakai." });
  const up = await patch(`/master/categories/${a.body.data.id}`, { name: "Nasi Kotak Besar", sort_order: 7, slug: "hack", is_active: false }).expect(200);
  expect(up.body.data).toMatchObject({ name: "Nasi Kotak Besar", slug: "nasi-kotak", sort_order: 7 });
  expect(Boolean(up.body.data.is_active)).toBe(true);
  await patch(`/master/categories/${b.body.data.id}`, { name: "Nasi Kotak Besar" }).expect(409);
  const l = await logs("master.categories.%");
  expect(l.map((x) => x.action)).toEqual(["master.categories.create", "master.categories.create", "master.categories.update"]);
  expect(l[2].before_json.name).toBe("Nasi Kotak");
  expect(l[2].after_json.name).toBe("Nasi Kotak Besar");
});

test("validasi: nama kosong / terlalu panjang / sort_order negatif → 400; id tak ada → 404", async () => {
  const r = await post("/master/categories", { name: "   " }).expect(400);
  expect(r.body.error.fields.name).toBeTruthy();
  await post("/master/categories", { name: "x".repeat(61) }).expect(400);
  await post("/master/pickup-points", { name: "ok", description: "d".repeat(256) }).expect(400);
  await post("/master/merchant-types", { name: "x".repeat(101) }).expect(400);
  await patch("/master/categories/1", { sort_order: -1 }).expect(400);
  await patch("/master/categories/99999", { name: "Zzz" }).expect(404);
});

test("nonaktifkan kategori: baris tetap ada; idempoten tanpa log", async () => {
  const id = (await post("/master/categories", { name: "Kue" }).expect(201)).body.data.id;
  const n0 = (await logs()).length;
  const d = await post(`/master/categories/${id}/deactivate`).expect(200);
  expect(Boolean(d.body.data.is_active)).toBe(false);
  expect((await logs()).length).toBe(n0 + 1);
  await post(`/master/categories/${id}/deactivate`).expect(200);
  expect((await logs()).length).toBe(n0 + 1);
  const list = (await get("/master/categories").expect(200)).body.data;
  expect(Boolean(list.find((c: any) => c.id === id).is_active)).toBe(false);
  const act = await post(`/master/categories/${id}/activate`).expect(200);
  expect(Boolean(act.body.data.is_active)).toBe(true);
  expect((await logs()).slice(-1)[0].action).toBe("master.categories.activate");
});

test("jenis usaha nonaktif tidak muncul di /meta/merchant-types; urut sort_order", async () => {
  const id = (await post("/master/merchant-types", { name: "Jenis Baru" }).expect(201)).body.data.id;
  await post(`/master/merchant-types/${id}/deactivate`).expect(200);
  await patch("/master/merchant-types/2", { sort_order: 99 }).expect(200);
  const r = (await request(app).get("/api/v1/meta/merchant-types").expect(200)).body.data;
  expect(r.find((t: any) => t.id === id)).toBeUndefined();
  expect(r.map((t: any) => t.id)).toEqual([1, 3, 4, 5, 2]);
});

test("titik temu: nonaktifkan titik temu terakhir toko terverifikasi → 409 + nama toko", async () => {
  const mk = async (n: string, phone: string, status: string) => {
    const [u] = await db.query<any>("INSERT INTO users (full_name, phone, password_hash, role) VALUES (?, ?, 'x', 'merchant')", [n, phone]);
    const [m] = await db.query<any>(
      "INSERT INTO merchants (user_id, merchant_type_id, business_name, slug, address, wa_number, verification_status) VALUES (?, 1, ?, ?, 'Jl. A', ?, ?)",
      [u.insertId, `Dapur ${n}`, `dapur-${n}`, phone, status]);
    return m.insertId as number;
  };
  const p1 = (await post("/master/pickup-points", { name: "Titik Satu", description: "Gerbang" }).expect(201)).body.data.id;
  const p2 = (await post("/master/pickup-points", { name: "Titik Dua" }).expect(201)).body.data.id;
  const siti = await mk("Siti", "081200000001", "verified");
  const budi = await mk("Budi", "081200000002", "verified");
  const wati = await mk("Wati", "081200000003", "pending");
  const link = (m: number, p: number) => db.query("INSERT INTO merchant_pickup_points (merchant_id, pickup_point_id) VALUES (?, ?)", [m, p]);
  await link(siti, p1); await link(budi, p1); await link(budi, p2); await link(wati, p1);
  // p1 satu-satunya untuk Siti (Wati pending tidak dihitung; Budi punya p2)
  const n0 = (await logs()).length;
  const r = await post(`/master/pickup-points/${p1}/deactivate`).expect(409);
  expect(r.body.error.message).toBe("Titik temu ini satu-satunya untuk toko: Dapur Siti.");
  expect((await logs()).length).toBe(n0);
  expect(Boolean((await get("/master/pickup-points")).body.data.find((p: any) => p.id === p1).is_active)).toBe(true);
  // p2 cadangan Budi saja → boleh dinonaktifkan? Budi masih punya p1 aktif → ya
  await post(`/master/pickup-points/${p2}/deactivate`).expect(200);
  // kini p1 satu-satunya untuk Siti dan Budi
  const r2 = await post(`/master/pickup-points/${p1}/deactivate`).expect(409);
  expect(r2.body.error.message).toBe("Titik temu ini satu-satunya untuk toko: Dapur Siti, Dapur Budi.");
});

test("jenis usaha & kategori baru tampil paling akhir", async () => {
  const t = (await post("/master/merchant-types", { name: "Jenis Terakhir" }).expect(201)).body.data;
  const meta = (await request(app).get("/api/v1/meta/merchant-types").expect(200)).body.data;
  expect(meta[meta.length - 1].id).toBe(t.id);
  const c = (await post("/master/categories", { name: "Kategori Terakhir" }).expect(201)).body.data;
  const list = (await get("/master/categories").expect(200)).body.data;
  expect(list[list.length - 1].id).toBe(c.id);
});

test("slug: nama 60 karakter bertabrakan tetap muat di kolom", async () => {
  const nm = "a".repeat(60);
  const s1 = (await post("/master/categories", { name: nm }).expect(201)).body.data.slug;
  const s2 = (await post("/master/categories", { name: nm.slice(0, 59) + "b" }).expect(201)).body.data.slug;
  expect(s1.length).toBeLessThanOrEqual(60);
  expect(s2.length).toBeLessThanOrEqual(60);
  expect(s2).not.toBe(s1);
});

test("PATCH tanpa perubahan → 200 tanpa log; PATCH kosong → 400; duplikat titik temu → 409", async () => {
  const id = (await post("/master/pickup-points", { name: "Titik Patch", description: "d" }).expect(201)).body.data.id;
  await post("/master/pickup-points", { name: "Titik Patch Lain" }).expect(201);
  const n0 = (await logs()).length;
  await patch(`/master/pickup-points/${id}`, { name: "Titik Patch", description: "d" }).expect(200);
  expect((await logs()).length).toBe(n0);
  await patch(`/master/pickup-points/${id}`, {}).expect(400);
  await patch(`/master/pickup-points/${id}`, { name: "Titik Patch Lain" }).expect(409);
});

test("titik temu satu-satunya toko dengan pemilik nonaktif boleh dinonaktifkan", async () => {
  const p = (await post("/master/pickup-points", { name: "Titik Pemilik Mati" }).expect(201)).body.data.id;
  const [u] = await db.query<any>("INSERT INTO users (full_name, phone, password_hash, role, is_active) VALUES ('Mati', '081200000099', 'x', 'merchant', 0)");
  const [m] = await db.query<any>("INSERT INTO merchants (user_id, merchant_type_id, business_name, slug, address, wa_number, verification_status) VALUES (?, 1, 'Dapur Mati', 'dapur-mati', 'Jl. A', '081200000099', 'verified')", [u.insertId]);
  await db.query("INSERT INTO merchant_pickup_points (merchant_id, pickup_point_id) VALUES (?, ?)", [m.insertId, p]);
  await post(`/master/pickup-points/${p}/deactivate`).expect(200);
});

test("daftar titik temu urut nama; tanpa token 401", async () => {
  const mine = ["Zeta Uji", "Alfa Uji", "Mid Uji"];
  for (const n of mine) await post("/master/pickup-points", { name: n }).expect(201);
  const names = (await get("/master/pickup-points").expect(200)).body.data.map((p: any) => p.name).filter((n: string) => mine.includes(n));
  expect(names).toEqual(["Alfa Uji", "Mid Uji", "Zeta Uji"]);
  await request(app).get("/api/v1/admin/master/categories").expect(401);
});

test("id tidak valid pada activate/deactivate → 404", async () => {
  await post("/master/pickup-points/abc/deactivate").expect(404);
  await post("/master/categories/abc/activate").expect(404);
  await post("/master/pickup-points/0/deactivate").expect(404);
});

test("dua titik temu satu toko dinonaktifkan bersamaan: tepat satu 200 dan satu 409, tanpa 500", async () => {
  const [u] = await db.query<any>("INSERT INTO users (full_name, phone, password_hash, role) VALUES ('Race', '081200000077', 'x', 'merchant')");
  const [m] = await db.query<any>("INSERT INTO merchants (user_id, merchant_type_id, business_name, slug, address, wa_number, verification_status) VALUES (?, 1, 'Dapur Race', 'dapur-race', 'Jl. A', '081200000077', 'verified')", [u.insertId]);
  const p1 = (await post("/master/pickup-points", { name: "Race Satu" }).expect(201)).body.data.id;
  const p2 = (await post("/master/pickup-points", { name: "Race Dua" }).expect(201)).body.data.id;
  await db.query("INSERT INTO merchant_pickup_points (merchant_id, pickup_point_id) VALUES (?, ?), (?, ?)", [m.insertId, p1, m.insertId, p2]);
  for (let i = 0; i < 5; i++) {
    await db.query("UPDATE pickup_points SET is_active = TRUE WHERE id IN (?, ?)", [p1, p2]);
    const rs = await Promise.all([post(`/master/pickup-points/${p1}/deactivate`), post(`/master/pickup-points/${p2}/deactivate`)]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    const [rows] = await db.query<any[]>("SELECT COUNT(*) n FROM pickup_points WHERE id IN (?, ?) AND is_active", [p1, p2]);
    expect(Number(rows[0].n)).toBe(1);
  }
});

test("registrasi penjual dengan jenis usaha nonaktif → 400 merchant_type_id (review akhir A1)", async () => {
  const id = (await post("/master/merchant-types", { name: "Jenis Pensiun" }).expect(201)).body.data.id;
  await post(`/master/merchant-types/${id}/deactivate`).expect(200);
  const r = await request(app).post("/api/v1/auth/merchant/register").send({
    full_name: "Tono", email: "tono@mail.com", phone: "081277778888", password: "rahasia123",
    business_name: "Dapur Tono", merchant_type_id: id, address: "Jl. Melati 2",
  }).expect(400);
  expect(r.body.error.fields.merchant_type_id).toEqual(["Jenis usaha tidak dikenal."]);
  expect((await db.query<any[]>("SELECT id FROM users WHERE phone = '081277778888'"))[0]).toHaveLength(0);
});
