import request from "supertest";
import { afterEach, beforeEach, expect, test } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { migrate } from "../src/db/migrate";
import { loginLimiter } from "../src/auth/rateLimit";
import { resetTestDatabase } from "./helpers/db";
import { fotoUrl, isiR2 } from "./helpers/toko";

let tA: string;
let idA: number, idB: number;

const login = async (identifier: string) =>
  (await request(app).post("/api/v1/auth/login").send({ identifier, password: "rahasia123", client: "web" })).body.data.token as string;
const regMerchant = (name: string, phone: string, email: string) =>
  request(app).post("/api/v1/auth/merchant/register").send({
    full_name: name, email, phone, password: "rahasia123", business_name: `Dapur ${name}`, merchant_type_id: 1, address: "Jl. Mawar 1",
  }).expect(201);
const row = async (id: number) => ((await db.query<any[]>("SELECT * FROM merchants WHERE id=?", [id]))[0] as any[])[0];
const patch = (b: object) => request(app).patch("/api/v1/merchant/profile").set("Authorization", `Bearer ${tA}`).send(b);
const getProfile = () => request(app).get("/api/v1/merchant/profile").set("Authorization", `Bearer ${tA}`);

beforeEach(async () => {
  await migrate(await resetTestDatabase());
  loginLimiter.reset();
  await regMerchant("Siti", "081298765432", "siti@mail.com");
  await regMerchant("Andi", "081211112222", "andi@mail.com");
  tA = await login("siti@mail.com");
  const [rows] = await db.query<any[]>("SELECT id FROM merchants ORDER BY id");
  idA = rows[0].id;
  idB = rows[1].id;
});

test("ubah semua field valid: respons dirapikan dan sama dengan GET", async () => {
  const r = await patch({
    business_name: "  Dapur Baru ", description: "", address: " Jl. Melati 2 ", wa_number: "081355556666", service_mode: "daily",
    open_time: "06:00", close_time: "17:30", hold_minutes: 10, daily_revenue_target: 500000, wa_template: "Halo {nama}, {kode}",
  }).expect(200);
  expect(r.body.data).toMatchObject({
    business_name: "Dapur Baru", description: null, address: "Jl. Melati 2", wa_number: "081355556666", service_mode: "daily",
    open_time: "06:00", close_time: "17:30", hold_minutes: 10, daily_revenue_target: 500000, wa_template: "Halo {nama}, {kode}",
  });
  expect((await getProfile()).body.data).toEqual(r.body.data);
});

test("mass assignment & toko lain tidak tersentuh", async () => {
  const before = await row(idB);
  await patch({
    business_name: "X", verification_status: "verified", is_open: false, slug: "x", rating_avg: 5, user_id: before.user_id,
    merchant_type_id: 2,
  }).expect(200);
  const a = await row(idA);
  expect(a).toMatchObject({ business_name: "X", verification_status: "pending", is_open: 1, merchant_type_id: 1, logo_url: null, qris_image_url: null });
  expect(a.slug).not.toBe("x");
  expect(a.rating_avg).toBe("0.00");
  expect(a.user_id).not.toBe(before.user_id);
  expect(await row(idB)).toEqual(before);
});

test("slug tetap saat nama diubah; body kosong/asing → 400", async () => {
  const slug = (await row(idA)).slug;
  await patch({ business_name: "Nama Lain" }).expect(200);
  expect((await row(idA)).slug).toBe(slug);
  for (const b of [{}, { slug: "x", is_open: false }]) {
    const r = await patch(b).expect(400);
    expect(r.body.error.message).toBe("Tidak ada data yang diubah.");
  }
});

test("jam: simpan apa adanya, close harus setelah open", async () => {
  const ok = await patch({ open_time: "07:30", close_time: "15:00" }).expect(200);
  expect(ok.body.data).toMatchObject({ open_time: "07:30", close_time: "15:00" });
  const same = await patch({ open_time: "16:00", close_time: "16:00" }).expect(400);
  expect(same.body.error.fields.close_time).toEqual(["Jam tutup harus setelah jam buka."]);
  await patch({ open_time: "07:00", close_time: "16:00" }).expect(200);
  const lone = await patch({ close_time: "06:00" }).expect(400);
  expect(lone.body.error.fields.close_time).toEqual(["Jam tutup harus setelah jam buka."]);
  const lone2 = await patch({ open_time: "16:00" }).expect(400);
  expect(lone2.body.error.fields.close_time).toEqual(["Jam tutup harus setelah jam buka."]);
  const fmt = await patch({ open_time: "7:00" }).expect(400);
  expect(fmt.body.error.fields.open_time).toEqual(["Jam harus berformat JJ:MM."]);
  expect(await getProfile().then((r) => [r.body.data.open_time, r.body.data.close_time])).toEqual(["07:00", "16:00"]);
});

test("validasi angka & pilihan", async () => {
  for (const v of [0, 31, 2.5]) expect((await patch({ hold_minutes: v }).expect(400)).body.error.fields.hold_minutes).toBeDefined();
  expect((await patch({ wa_number: "6281234567890" }).expect(400)).body.error.fields.wa_number).toEqual(["Nomor WA harus diawali 08 dan 10–13 digit."]);
  expect((await patch({ service_mode: "x" }).expect(400)).body.error.fields.service_mode).toEqual(["Pilih mode layanan."]);
  expect((await patch({ daily_revenue_target: -1 }).expect(400)).body.error.fields.daily_revenue_target).toBeDefined();
  expect((await patch({ business_name: "   " }).expect(400)).body.error.fields.business_name).toBeDefined();
});

test("templat WA", async () => {
  await patch({ wa_template: "Halo {nama}, {kode}" }).expect(200);
  expect((await row(idA)).wa_template).toBe("Halo {nama}, {kode}");
  expect((await patch({ wa_template: "   " }).expect(400)).body.error.fields.wa_template).toEqual(["Templat tidak boleh kosong."]);
  expect((await patch({ wa_template: "a".repeat(1001) }).expect(400)).body.error.fields.wa_template).toEqual(["Templat maksimal 1.000 karakter."]);
  expect((await patch({ wa_template: "{harga} {diskon}" }).expect(400)).body.error.fields.wa_template).toEqual(["Kata kunci {harga}, {diskon} tidak dikenal."]);
});

// F04 D10/D15: logo & QRIS hanya dari unggahan milik toko sendiri (dulu diabaikan, F03 D4 dicabut)
test("logo_url & qris_image_url: URL unggahan sendiri diterima, null mengosongkan, selain itu 400", async () => {
  isiR2();
  const logo = fotoUrl(`merchants/${idA}/logo/`);
  const r = await patch({ logo_url: logo, qris_image_url: fotoUrl(`merchants/${idA}/qris/`, "jpg") }).expect(200);
  expect(r.body.data.logo_url).toBe(logo);
  await patch({ logo_url: logo }).expect(200); // sama dengan tersimpan
  expect((await patch({ qris_image_url: null }).expect(200)).body.data.qris_image_url).toBeNull();
  const before = await row(idA);
  const uuid = "0b9a4b7e-1f3e-4c55-9d1a-2f6a0e3c9b11";
  for (const bad of [
    "https://evil.example/x.png",
    fotoUrl(`merchants/${idB}/logo/`),
    fotoUrl(`merchants/${idA}/menu/`),
    `https://foto.test/merchants/${idA}/logo/../${idB}/logo/${uuid}.png`,
    `https://foto.test/merchants/${idA}/logo/${uuid}.png?x=1`,
    `https://foto.test/merchants/${idA}/logo/${uuid}.svg`,
    `https://FOTO.TEST/merchants/${idA}/logo/${uuid}.png`,
    `https://foto.test/merchants/${idA}/logo/${uuid.toUpperCase()}.png`,
    `https://foto.test.evil/merchants/${idA}/logo/${uuid}.png`,
    123,
  ]) {
    const x = await patch({ logo_url: bad }).expect(400);
    expect(x.body.error.fields.logo_url).toEqual(["Foto tidak valid. Unggah ulang foto."]);
  }
  expect((await patch({ qris_image_url: "https://evil.example/q.png" }).expect(400)).body.error.fields.qris_image_url)
    .toEqual(["Foto tidak valid. Unggah ulang foto."]);
  expect(await row(idA)).toEqual(before);
});

test("logo_url/qris_image_url \"\" mengosongkan seperti null", async () => {
  await db.query("UPDATE merchants SET logo_url = '/logo/lama.png', qris_image_url = '/q.png' WHERE id = ?", [idA]);
  const r = await patch({ logo_url: "", qris_image_url: "" }).expect(200);
  expect(r.body.data).toMatchObject({ logo_url: null, qris_image_url: null });
});

test("logo_url saat unggah belum tersedia: hanya null atau nilai tersimpan", async () => {
  await db.query("UPDATE merchants SET logo_url = '/logo/lama.png' WHERE id = ?", [idA]);
  await patch({ logo_url: "/logo/lama.png", business_name: "Tetap" }).expect(200);
  expect((await patch({ logo_url: "https://foto.test/merchants/1/logo/x.png" }).expect(400)).body.error.fields.logo_url).toBeDefined();
  expect((await patch({ logo_url: null }).expect(200)).body.data.logo_url).toBeNull();
});

afterEach(() => { isiR2(false); });
