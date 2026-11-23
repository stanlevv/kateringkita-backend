import request from "supertest";
import { afterEach, beforeEach, expect, test } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { freezeClock, photoUrl, setR2Env, prepareMerchants, insertMenu, makeVisible } from "./helpers/merchant";

// Background profil toko (cover_url) + foto tambahan menu (gallery, maks 4 selain foto utama image_url)
let tokenA: string, tokenB: string, idA: number, idB: number;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const patchProfile = (body: object, token = tokenA) =>
  request(app).patch("/api/v1/merchant/profile").set(auth(token)).send(body);
const postMenu = (body: object) => request(app).post("/api/v1/merchant/menus").set(auth(tokenA)).send(body);
const patchMenu = (id: number, body: object) =>
  request(app).patch(`/api/v1/merchant/menus/${id}`).set(auth(tokenA)).send(body);
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
const INVALID_PHOTO_ERRORS = ["Foto tidak valid. Unggah ulang foto."];

beforeEach(async () => {
  freezeClock();
  ({ tokenA, tokenB, idA, idB } = await prepareMerchants());
  setR2Env();
});
afterEach(() => {
  setR2Env(false);
});

test("unggah purpose cover → kunci di bawah merchants/<id>/cover/", async () => {
  const res = await request(app)
    .post("/api/v1/merchant/uploads")
    .set(auth(tokenA))
    .send({ purpose: "cover", content_type: "image/jpeg", size: 1000 })
    .expect(200);
  expect(res.body.data.public_url).toMatch(new RegExp(`/merchants/${idA}/cover/[0-9a-f-]{36}\\.jpg$`));
});

test("cover_url: unggahan cover sendiri diterima & tampil di profil penjual dan publik; selain itu 400; null mengosongkan", async () => {
  const cover = photoUrl(`merchants/${idA}/cover/`, "jpg");
  expect((await patchProfile({ cover_url: cover }).expect(200)).body.data.cover_url).toBe(cover);
  expect((await request(app).get("/api/v1/merchant/profile").set(auth(tokenA)).expect(200)).body.data.cover_url).toBe(
    cover,
  );
  await makeVisible(idA);
  const [[merchantRow]] = await db.query<any[]>("SELECT slug FROM merchants WHERE id = ?", [idA]);
  expect((await request(app).get(`/api/v1/merchants/${merchantRow.slug}`).expect(200)).body.data.cover_url).toBe(cover);
  for (const bad of [
    photoUrl(`merchants/${idA}/logo/`),
    photoUrl(`merchants/${idB}/cover/`),
    "https://evil.example/x.jpg",
  ]) {
    expect((await patchProfile({ cover_url: bad }).expect(400)).body.error.fields.cover_url).toEqual(
      INVALID_PHOTO_ERRORS,
    );
  }
  expect((await patchProfile({ cover_url: null }).expect(200)).body.data.cover_url).toBeNull();
  expect(
    (await patchProfile({ cover_url: photoUrl(`merchants/${idB}/cover/`) }, tokenB).expect(200)).body.data.cover_url,
  ).toContain(`/${idB}/cover/`);
});

test("gallery: POST menyimpan foto tambahan sesuai urutan; PATCH menerima foto tersimpan + unggahan baru; [] mengosongkan", async () => {
  const [gallery1, gallery2, gallery3] = [1, 2, 3].map(() => photoUrl(`merchants/${idA}/menu/`, "webp"));
  const createdMenu = (
    await postMenu({
      ...baseMenu(),
      image_url: photoUrl(`merchants/${idA}/menu/`),
      gallery: [gallery1, gallery2],
    }).expect(201)
  ).body.data;
  expect(createdMenu.gallery).toEqual([gallery1, gallery2]);
  expect((await postMenu(baseMenu()).expect(201)).body.data.gallery).toEqual([]);
  expect(
    (await patchMenu(createdMenu.id, { gallery: [gallery2, gallery3, gallery1] }).expect(200)).body.data.gallery,
  ).toEqual([gallery2, gallery3, gallery1]);
  expect((await patchMenu(createdMenu.id, { name: "Ganti nama" }).expect(200)).body.data.gallery).toEqual([
    gallery2,
    gallery3,
    gallery1,
  ]);
  expect((await patchMenu(createdMenu.id, { gallery: [] }).expect(200)).body.data.gallery).toEqual([]);
});

test("gallery: maks 4, tanpa duplikat, hanya unggahan menu milik toko sendiri", async () => {
  const ownPhotoUrl = () => photoUrl(`merchants/${idA}/menu/`);
  const ownPhoto = ownPhotoUrl();
  const expectRejected = async (gallery: unknown) =>
    (await postMenu({ ...baseMenu(), gallery }).expect(400)).body.error.fields.gallery;
  expect(await expectRejected([1, 2, 3, 4, 5].map(ownPhotoUrl))).toEqual(["Maksimal 4 foto tambahan."]);
  expect(await expectRejected([ownPhoto, ownPhoto])).toEqual(["Foto tambahan tidak boleh sama."]);
  expect(await expectRejected([photoUrl(`merchants/${idB}/menu/`)])).toEqual(INVALID_PHOTO_ERRORS);
  expect(await expectRejected([photoUrl(`merchants/${idA}/logo/`)])).toEqual(INVALID_PHOTO_ERRORS);
  expect(await expectRejected("bukan-daftar")).toBeDefined();
});

test("GET /menus/:id publik memuat gallery; menu tanpa foto tambahan → []", async () => {
  await makeVisible(idA);
  const photo = photoUrl(`merchants/${idA}/menu/`);
  const id = await insertMenu(idA, { gallery: JSON.stringify([photo]) });
  expect((await request(app).get(`/api/v1/menus/${id}`).expect(200)).body.data.gallery).toEqual([photo]);
  const plainMenu = await insertMenu(idA);
  expect((await request(app).get(`/api/v1/menus/${plainMenu}`).expect(200)).body.data.gallery).toEqual([]);
});
