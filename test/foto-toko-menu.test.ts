import request from "supertest";
import { afterEach, beforeEach, expect, test } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { bekukanJam, fotoUrl, isiR2, siapkanToko, sisipMenu, tampilkan } from "./helpers/toko";

// Background profil toko (cover_url) + foto tambahan menu (gallery, maks 4 selain foto utama image_url)
let tA: string, tB: string, idA: number, idB: number;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const profil = (b: object, t = tA) => request(app).patch("/api/v1/merchant/profile").set(auth(t)).send(b);
const postMenu = (b: object) => request(app).post("/api/v1/merchant/menus").set(auth(tA)).send(b);
const patchMenu = (id: number, b: object) => request(app).patch(`/api/v1/merchant/menus/${id}`).set(auth(tA)).send(b);
const dasar = () => ({
  name: "Nasi Ayam", category_id: 1, description: "Enak", image_url: null, unit_label: "porsi", price: 15000, hpp: 9000,
  daily_quota: 20, prep_minutes: 15, is_preorder: false, preorder_days: 0, min_order_qty: 1, options: [],
});
const TIDAK_VALID = ["Foto tidak valid. Unggah ulang foto."];

beforeEach(async () => {
  bekukanJam();
  ({ tA, tB, idA, idB } = await siapkanToko());
  isiR2();
});
afterEach(() => { isiR2(false); });

test("unggah purpose cover → kunci di bawah merchants/<id>/cover/", async () => {
  const r = await request(app).post("/api/v1/merchant/uploads").set(auth(tA))
    .send({ purpose: "cover", content_type: "image/jpeg", size: 1000 }).expect(200);
  expect(r.body.data.public_url).toMatch(new RegExp(`/merchants/${idA}/cover/[0-9a-f-]{36}\\.jpg$`));
});

test("cover_url: unggahan cover sendiri diterima & tampil di profil penjual dan publik; selain itu 400; null mengosongkan", async () => {
  const cover = fotoUrl(`merchants/${idA}/cover/`, "jpg");
  expect((await profil({ cover_url: cover }).expect(200)).body.data.cover_url).toBe(cover);
  expect((await request(app).get("/api/v1/merchant/profile").set(auth(tA)).expect(200)).body.data.cover_url).toBe(cover);
  await tampilkan(idA);
  const [[m]] = await db.query<any[]>("SELECT slug FROM merchants WHERE id = ?", [idA]);
  expect((await request(app).get(`/api/v1/merchants/${m.slug}`).expect(200)).body.data.cover_url).toBe(cover);
  for (const bad of [fotoUrl(`merchants/${idA}/logo/`), fotoUrl(`merchants/${idB}/cover/`), "https://evil.example/x.jpg"]) {
    expect((await profil({ cover_url: bad }).expect(400)).body.error.fields.cover_url).toEqual(TIDAK_VALID);
  }
  expect((await profil({ cover_url: null }).expect(200)).body.data.cover_url).toBeNull();
  expect((await profil({ cover_url: fotoUrl(`merchants/${idB}/cover/`) }, tB).expect(200)).body.data.cover_url).toContain(`/${idB}/cover/`);
});

test("gallery: POST menyimpan foto tambahan sesuai urutan; PATCH menerima foto tersimpan + unggahan baru; [] mengosongkan", async () => {
  const [g1, g2, g3] = [1, 2, 3].map(() => fotoUrl(`merchants/${idA}/menu/`, "webp"));
  const m = (await postMenu({ ...dasar(), image_url: fotoUrl(`merchants/${idA}/menu/`), gallery: [g1, g2] }).expect(201)).body.data;
  expect(m.gallery).toEqual([g1, g2]);
  expect((await postMenu(dasar()).expect(201)).body.data.gallery).toEqual([]);
  expect((await patchMenu(m.id, { gallery: [g2, g3, g1] }).expect(200)).body.data.gallery).toEqual([g2, g3, g1]);
  expect((await patchMenu(m.id, { name: "Ganti nama" }).expect(200)).body.data.gallery).toEqual([g2, g3, g1]);
  expect((await patchMenu(m.id, { gallery: [] }).expect(200)).body.data.gallery).toEqual([]);
});

test("gallery: maks 4, tanpa duplikat, hanya unggahan menu milik toko sendiri", async () => {
  const sendiri = () => fotoUrl(`merchants/${idA}/menu/`);
  const g = sendiri();
  const tolak = async (gallery: unknown) => (await postMenu({ ...dasar(), gallery }).expect(400)).body.error.fields.gallery;
  expect(await tolak([1, 2, 3, 4, 5].map(sendiri))).toEqual(["Maksimal 4 foto tambahan."]);
  expect(await tolak([g, g])).toEqual(["Foto tambahan tidak boleh sama."]);
  expect(await tolak([fotoUrl(`merchants/${idB}/menu/`)])).toEqual(TIDAK_VALID);
  expect(await tolak([fotoUrl(`merchants/${idA}/logo/`)])).toEqual(TIDAK_VALID);
  expect(await tolak("bukan-daftar")).toBeDefined();
});

test("GET /menus/:id publik memuat gallery; menu tanpa foto tambahan → []", async () => {
  await tampilkan(idA);
  const g = fotoUrl(`merchants/${idA}/menu/`);
  const id = await sisipMenu(idA, { gallery: JSON.stringify([g]) });
  expect((await request(app).get(`/api/v1/menus/${id}`).expect(200)).body.data.gallery).toEqual([g]);
  const polos = await sisipMenu(idA);
  expect((await request(app).get(`/api/v1/menus/${polos}`).expect(200)).body.data.gallery).toEqual([]);
});
