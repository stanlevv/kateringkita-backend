import request from "supertest";
import { afterEach, beforeEach, expect, test } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { migrate } from "../src/db/migrate";
import { createAdmin } from "../src/admin/create";
import { loginLimiter, passwordLimiter } from "../src/auth/rateLimit";
import { resetTestDatabase } from "./helpers/db";
import { fotoUrl, isiR2 } from "./helpers/toko";

let customerToken: string;
let merchantToken: string;

const login = (identifier: string) =>
  request(app).post("/api/v1/auth/login").send({ identifier, password: "rahasia123", client: "web" });
const PW = "rahasia123";
const patch = (body: object, token?: string) => {
  const r = request(app).patch("/api/v1/me").send(body);
  return token ? r.set("Authorization", `Bearer ${token}`) : r;
};

beforeEach(async () => {
  await migrate(await resetTestDatabase());
  loginLimiter.reset();
  passwordLimiter.reset();
  await request(app)
    .post("/api/v1/auth/customer/register")
    .send({ full_name: "Budi", email: "budi@mail.com", phone: "081234567890", password: "rahasia123" })
    .expect(201);
  await request(app)
    .post("/api/v1/auth/merchant/register")
    .send({
      full_name: "Siti",
      email: "siti@mail.com",
      phone: "081298765432",
      password: "rahasia123",
      business_name: "Dapur Siti",
      merchant_type_id: 1,
      address: "Jl. Mawar 1",
    })
    .expect(201);
  customerToken = (await login("budi@mail.com")).body.data.token;
  merchantToken = (await login("siti@mail.com")).body.data.token;
});

test("tanpa token → 401", async () => {
  expect((await patch({ full_name: "X" })).status).toBe(401);
});

test("ubah nama: dipangkas, tanpa password_hash, bentuk sama dengan GET /me", async () => {
  const res = await patch({ full_name: "  Budi Baru " }, customerToken);
  expect(res.status).toBe(200);
  expect(res.body.data.user.full_name).toBe("Budi Baru");
  expect(res.body.data.user.avatar_url).toBeNull();
  expect(res.body.data.user.favorite_pickup_point_id).toBeNull();
  expect(res.body.data.merchant).toBeNull();
  expect(JSON.stringify(res.body)).not.toContain("password_hash");
});

test("body kosong → 200, profil tak berubah", async () => {
  const res = await patch({}, customerToken);
  expect(res.status).toBe(200);
  expect(res.body.data.user.full_name).toBe("Budi");
});

test("mass assignment diabaikan", async () => {
  const res = await patch(
    { role: "admin", is_active: false, password_hash: "x" },
    customerToken,
  );
  expect(res.status).toBe(200);
  const [rows] = await db.query<any[]>("SELECT role, is_active, avatar_url, password_hash FROM users WHERE email = 'budi@mail.com'");
  expect(rows[0].role).toBe("customer");
  expect(rows[0].is_active).toBe(1);
  expect(rows[0].avatar_url).toBeNull();
  expect(rows[0].password_hash).not.toBe("x");
});

test("ganti nomor ke nomor akun lain → 409", async () => {
  const res = await patch({ phone: "081298765432", current_password: PW }, customerToken);
  expect(res.status).toBe(409);
  expect(res.body.error.code).toBe("CONFLICT");
});

test("email dinormalisasi; login email baru berhasil, email lama gagal", async () => {
  const res = await patch({ email: " Budi.Baru@Mail.com ", current_password: PW }, customerToken);
  expect(res.status).toBe(200);
  expect(res.body.data.user.email).toBe("budi.baru@mail.com");
  expect((await login("BUDI.BARU@mail.com")).status).toBe(200);
  expect((await login("budi@mail.com")).status).toBe(401);
});

test("email kosong: pembeli ditolak, penjual jadi null", async () => {
  const c = await patch({ email: "" }, customerToken);
  expect(c.status).toBe(400);
  expect(c.body.error.fields.email).toEqual(["Email wajib diisi."]);
  const m = await patch({ email: "", current_password: PW }, merchantToken);
  expect(m.status).toBe(200);
  expect(m.body.data.user.email).toBeNull();
});

test("titik temu favorit: valid, tidak ada, nonaktif, null", async () => {
  expect((await patch({ favorite_pickup_point_id: 2 }, customerToken)).body.data.user.favorite_pickup_point_id).toBe(2);
  const bad = await patch({ favorite_pickup_point_id: 99 }, customerToken);
  expect(bad.status).toBe(400);
  expect(bad.body.error.fields.favorite_pickup_point_id).toEqual(["Titik temu tidak tersedia."]);
  await db.query("UPDATE pickup_points SET is_active = FALSE WHERE id = 3");
  expect((await patch({ favorite_pickup_point_id: 3 }, customerToken)).status).toBe(400);
  const nul = await patch({ favorite_pickup_point_id: null }, customerToken);
  expect(nul.status).toBe(200);
  expect(nul.body.data.user.favorite_pickup_point_id).toBeNull();
});

test("email null: pembeli ditolak, penjual jadi null; non-string → pesan Indonesia", async () => {
  const c = await patch({ email: null }, customerToken);
  expect(c.status).toBe(400);
  expect(c.body.error.fields.email).toEqual(["Email wajib diisi."]);
  const m = await patch({ email: null, current_password: PW }, merchantToken);
  expect(m.status).toBe(200);
  expect(m.body.data.user.email).toBeNull();
  const n = await patch({ email: 123 }, customerToken);
  expect(n.status).toBe(400);
  expect(n.body.error.fields.email).toEqual(["Format email tidak valid."]);
});

test("email spasi saja: pembeli ditolak", async () => {
  const c = await patch({ email: "   " }, customerToken);
  expect(c.status).toBe(400);
  expect(c.body.error.fields.email).toEqual(["Email wajib diisi."]);
});

test("admin boleh mengosongkan email", async () => {
  await createAdmin({ phone: "081300000009", fullName: "Admin Uji", password: "rahasia123" });
  await db.query("UPDATE users SET email = 'admin@mail.com' WHERE phone = '081300000009'");
  const token = (await login("081300000009")).body.data.token;
  const res = await patch({ email: "", current_password: PW }, token);
  expect(res.status).toBe(200);
  expect(res.body.data.user.email).toBeNull();
});

test("ubah nomor tanpa current_password → 400", async () => {
  const res = await patch({ phone: "081200000001" }, customerToken);
  expect(res.status).toBe(400);
  expect(res.body.error.fields.current_password).toEqual(["Masukkan kata sandi saat ini untuk mengubah email atau nomor."]);
});

test("ubah email dengan current_password salah → 400", async () => {
  const res = await patch({ email: "baru@mail.com", current_password: "salahsalah1" }, customerToken);
  expect(res.status).toBe(400);
  expect(res.body.error.fields.current_password).toEqual(["Kata sandi lama salah."]);
});

test("ubah nomor dengan sandi benar → 200 dan login nomor baru berhasil", async () => {
  const res = await patch({ phone: "081200000001", current_password: PW }, customerToken);
  expect(res.status).toBe(200);
  expect(res.body.data.user.phone).toBe("081200000001");
  expect((await login("081200000001")).status).toBe(200);
});

test("ubah nama saja, atau kirim email/nomor yang sama, tanpa sandi → 200", async () => {
  expect((await patch({ full_name: "Budi Lagi" }, customerToken)).status).toBe(200);
  expect((await patch({ phone: "081234567890", email: "budi@mail.com" }, customerToken)).status).toBe(200);
});

test("ubah email ke email akun lain → 409", async () => {
  const res = await patch({ email: "siti@mail.com", current_password: PW }, customerToken);
  expect(res.status).toBe(409);
});

test("PATCH /me penjual mengembalikan merchant dengan verification_status", async () => {
  const res = await patch({ full_name: "Siti Baru" }, merchantToken);
  expect(res.status).toBe(200);
  expect(res.body.data.merchant).not.toBeNull();
  expect(res.body.data.merchant.verification_status).toBeDefined();
});

test("3 salah lewat PATCH + 3 salah lewat PUT /me/password berbagi jatah → ke-6 429", async () => {
  for (let i = 0; i < 3; i++) await patch({ phone: "081200000001", current_password: "salahsalah1" }, customerToken).expect(400);
  const put = () =>
    request(app)
      .put("/api/v1/me/password")
      .set("Authorization", `Bearer ${customerToken}`)
      .send({ current_password: "salahsalah1", new_password: "baru12345" });
  await put().expect(400);
  await put().expect(400);
  expect((await put()).status).toBe(429);
});

test("register & login menyertakan avatar_url dan favorite_pickup_point_id null", async () => {
  const reg = await request(app)
    .post("/api/v1/auth/customer/register")
    .send({ full_name: "Ani", email: "ani@mail.com", phone: "081211111111", password: "rahasia123" })
    .expect(201);
  expect(reg.body.data.user).toMatchObject({ avatar_url: null, favorite_pickup_point_id: null });
  const res = await login("ani@mail.com");
  expect(res.body.data.user).toMatchObject({ avatar_url: null, favorite_pickup_point_id: null });
});

// F04 D10/D15: avatar hanya dari unggahan milik pengguna sendiri (dulu diabaikan, F02 D1 dicabut)
test("avatar_url: unggahan sendiri diterima, null mengosongkan, selain itu 400", async () => {
  isiR2();
  const [[c]] = await db.query<any[]>("SELECT id FROM users WHERE email = 'budi@mail.com'");
  const [[m]] = await db.query<any[]>("SELECT id FROM users WHERE email = 'siti@mail.com'");
  const url = fotoUrl(`users/${c.id}/avatar/`, "webp");
  expect((await patch({ avatar_url: url }, customerToken)).body.data.user.avatar_url).toBe(url);
  const uuid = "0b9a4b7e-1f3e-4c55-9d1a-2f6a0e3c9b11";
  for (const bad of [
    "https://x",
    fotoUrl(`users/${m.id}/avatar/`),
    `https://foto.test/users/${c.id}/avatar/../${m.id}/avatar/${uuid}.png`,
    `https://foto.test/users/${c.id}/avatar/${uuid}.png?x=1`,
  ]) {
    const r = await patch({ avatar_url: bad }, customerToken);
    expect(r.status).toBe(400);
    expect(r.body.error.fields.avatar_url).toEqual(["Foto tidak valid. Unggah ulang foto."]);
  }
  passwordLimiter.reset(); // 400 dari PATCH /me ikut batas bersama (API.md §3)
  const [rows] = await db.query<any[]>("SELECT avatar_url FROM users WHERE id = ?", [c.id]);
  expect(rows[0].avatar_url).toBe(url);
  expect((await patch({ avatar_url: null }, customerToken)).body.data.user.avatar_url).toBeNull();
  await db.query("UPDATE users SET avatar_url = ? WHERE id = ?", [url, c.id]);
  expect((await patch({ avatar_url: "" }, customerToken)).body.data.user.avatar_url).toBeNull();
});

afterEach(() => { isiR2(false); });
