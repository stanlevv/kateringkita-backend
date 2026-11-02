import request from "supertest";
import { afterEach, beforeEach, expect, test } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { fotoUrl, isiR2, menuRow, siapkanToko, sisipMenu } from "./helpers/toko";

let tA: string, tB: string, idA: number, idB: number;

const post = (b: object, t = tA) => request(app).post("/api/v1/merchant/menus").set("Authorization", `Bearer ${t}`).send(b);
const patch = (id: number, b: object, t = tA) => request(app).patch(`/api/v1/merchant/menus/${id}`).set("Authorization", `Bearer ${t}`).send(b);
const field = async (b: object, f: string) => (await post({ ...dasar(), ...b }).expect(400)).body.error.fields[f];
const dasar = () => ({
  name: "Nasi Ayam", category_id: 1, description: "Enak", image_url: null, unit_label: "porsi", price: 15000, hpp: 9000,
  daily_quota: 20, prep_minutes: 15, is_preorder: false, preorder_days: 0, min_order_qty: 1, options: [],
});

beforeEach(async () => {
  ({ tA, tB, idA, idB } = await siapkanToko());
  isiR2();
});
afterEach(() => { isiR2(false); });

test("POST valid lengkap → 201 bentuk D3, kuota hari ini = harian, teks dirapikan", async () => {
  const foto = fotoUrl(`merchants/${idA}/menu/`, "webp");
  const r = await post({
    ...dasar(), name: "  Nasi Ayam Bakar ", description: "", unit_label: " box ", image_url: foto, daily_quota: 25, preorder_days: 3,
    options: [{ name: " Keju ", extra_price: 3000 }, { name: "Sambal", extra_price: 0 }],
  }).expect(201);
  const m = r.body.data;
  expect(m).toMatchObject({
    name: "Nasi Ayam Bakar", description: null, unit_label: "box", image_url: foto, price: 15000, hpp: 9000, margin: 6000,
    daily_quota: 25, quota_today: 25, sold_today: 0, held_today: 0, available: 25, is_active: true, is_preorder: false, preorder_days: 0,
    category: { id: 1, name: "Nasi Box", slug: "nasi-box" }, rating_avg: 0, rating_count: 0,
  });
  expect(m.options.map((o: any) => [o.name, o.extra_price])).toEqual([["Keju", 3000], ["Sambal", 0]]);
  expect((await menuRow(m.id)).merchant_id).toBe(idA);
  const pre = await post({ ...dasar(), is_preorder: true, preorder_days: 2 }).expect(201);
  expect(pre.body.data).toMatchObject({ is_preorder: true, preorder_days: 2 });
});

test("POST validasi: pesan sama dengan web", async () => {
  expect(await field({ price: 12000, hpp: 12000 }, "price")).toEqual(["Harga jual harus lebih besar dari HPP (Rp 12.000)."]);
  expect(await field({ price: 999, hpp: 0 }, "price")).toEqual(["Harga jual minimal 1.000."]);
  expect(await field({ hpp: -1 }, "hpp")).toBeDefined();
  expect(await field({ daily_quota: 10001 }, "daily_quota")).toEqual(["Kuota harian maksimal 10.000."]);
  expect(await field({ prep_minutes: 0 }, "prep_minutes")).toBeDefined();
  expect(await field({ min_order_qty: 0 }, "min_order_qty")).toBeDefined();
  expect(await field({ price: 1.5 }, "price")).toEqual(["Harga jual harus bilangan bulat."]);
  expect(await field({ price: "15000" }, "price")).toEqual(["Harga jual wajib diisi."]);
  expect(await field({ is_preorder: true, preorder_days: 8 }, "preorder_days")).toEqual(["Hari pre-order harus 1 sampai 7."]);
  expect(await field({ is_preorder: true, preorder_days: 0 }, "preorder_days")).toEqual(["Hari pre-order harus 1 sampai 7."]);
  expect(await field({ category_id: 99 }, "category_id")).toEqual(["Kategori tidak ditemukan."]);
  await db.query("UPDATE categories SET is_active = FALSE WHERE id = 2");
  expect(await field({ category_id: 2 }, "category_id")).toEqual(["Kategori tidak ditemukan."]);
  expect(await field({ options: [{ name: "Keju", extra_price: 0 }, { name: "keju ", extra_price: 0 }] }, "options.1.name"))
    .toEqual(["Nama opsi sama dengan opsi lain."]);
  const banyak = Array.from({ length: 21 }, (_, i) => ({ name: `Opsi ${i}`, extra_price: 0 }));
  expect(await field({ options: banyak }, "options")).toBeDefined();
  expect(await field({ image_url: "https://evil.example/x.png" }, "image_url")).toEqual(["Foto tidak valid. Unggah ulang foto."]);
  expect(await field({ image_url: fotoUrl(`merchants/${idB}/menu/`) }, "image_url")).toBeDefined();
  expect(await field({ image_url: fotoUrl(`merchants/${idA}/logo/`) }, "image_url")).toBeDefined();
  expect((await db.query<any[]>("SELECT COUNT(*) AS n FROM menus"))[0][0].n).toBe(0);
});

test("POST mass assignment: kolom sistem & toko lain dibuang", async () => {
  const r = await post({
    ...dasar(), merchant_id: idB, sold_today: 5, held_today: 5, quota_today: 99, rating_avg: 5, deleted_at: "2020-01-01", is_active: false,
  }).expect(201);
  const row = await menuRow(r.body.data.id);
  expect(row).toMatchObject({ merchant_id: idA, sold_today: 0, held_today: 0, quota_today: 20, rating_avg: "0.00", deleted_at: null, is_active: 1 });
});

test("PATCH sebagian: antar-field dibanding nilai tersimpan; kuota harian tidak mengubah kuota hari ini", async () => {
  const id = await sisipMenu(idA, { price: 20000, hpp: 19000, daily_quota: 20, quota_today: 7 });
  await patch(id, { price: 20000 }).expect(200);
  expect((await patch(id, { price: 19500 }).expect(200)).body.data.margin).toBe(500);
  const bad = await patch(id, { hpp: 25000 }).expect(400);
  expect(bad.body.error.fields.price).toEqual(["Harga jual harus lebih besar dari HPP (Rp 25.000)."]);
  const kosong = await patch(id, {}).expect(400);
  expect(kosong.body.error.message).toBe("Tidak ada data yang diubah.");
  expect((await patch(id, { sold_today: 3, merchant_id: idB }).expect(400)).body.error.message).toBe("Tidak ada data yang diubah.");
  const q = await patch(id, { daily_quota: 50 }).expect(200);
  expect(q.body.data).toMatchObject({ daily_quota: 50, quota_today: 7 });
  expect((await patch(id, { is_preorder: true }).expect(400)).body.error.fields.preorder_days).toEqual(["Hari pre-order harus 1 sampai 7."]);
  expect((await patch(id, { is_preorder: true, preorder_days: 3 }).expect(200)).body.data.preorder_days).toBe(3);
  expect((await patch(id, { is_preorder: false }).expect(200)).body.data.preorder_days).toBe(0);
  const mass = await patch(id, { name: "Baru", merchant_id: idB, sold_today: 5, held_today: 5, quota_today: 99, rating_avg: 5, deleted_at: "2020-01-01" }).expect(200);
  expect(mass.body.data.name).toBe("Baru");
  expect(await menuRow(id)).toMatchObject({ merchant_id: idA, sold_today: 0, held_today: 0, quota_today: 7, rating_avg: "0.00", deleted_at: null });
});

test("opsi D8: sinkron berdasarkan nama, id dipertahankan, yang hilang dinonaktifkan", async () => {
  const id = await sisipMenu(idA);
  await db.query("INSERT INTO menu_options (menu_id, name, extra_price) VALUES (?, 'Keju', 1000), (?, 'Sambal', 0)", [id, id]);
  const [[k]] = await db.query<any[]>("SELECT id FROM menu_options WHERE name = 'Keju'");
  const [[s]] = await db.query<any[]>("SELECT id FROM menu_options WHERE name = 'Sambal'");
  const r = await patch(id, { options: [{ name: "keju", extra_price: 3000 }, { name: "Telur", extra_price: 2000 }] }).expect(200);
  expect(r.body.data.options).toEqual([
    { id: k.id, name: "keju", extra_price: 3000 },
    { id: expect.any(Number), name: "Telur", extra_price: 2000 },
  ]);
  const [[sambal]] = await db.query<any[]>("SELECT is_active FROM menu_options WHERE id = ?", [s.id]);
  expect(sambal.is_active).toBe(0);
  // mengaktifkan lagi opsi yang pernah dinonaktifkan mempertahankan id-nya
  const lagi = await patch(id, { options: [{ name: "Sambal", extra_price: 500 }] }).expect(200);
  expect(lagi.body.data.options).toEqual([{ id: s.id, name: "Sambal", extra_price: 500 }]);
  expect((await db.query<any[]>("SELECT COUNT(*) AS n FROM menu_options WHERE menu_id = ? AND name = 'Sambal'", [id]))[0][0].n).toBe(1);
  expect((await patch(id, { options: [] }).expect(200)).body.data.options).toEqual([]);
});

test("data lama: foto bukan R2 & kategori nonaktif yang sama dengan tersimpan diterima", async () => {
  const id = await sisipMenu(idA, { image_url: "/menu/1.png", category_id: 3 });
  await db.query("UPDATE categories SET is_active = FALSE WHERE id = 3");
  const r = await patch(id, { ...dasar(), category_id: 3, image_url: "/menu/1.png", description: "Lama" }).expect(200);
  expect(r.body.data).toMatchObject({ image_url: "/menu/1.png", category: { id: 3 } });
  expect((await patch(id, { image_url: "/menu/2.png" }).expect(400)).body.error.fields.image_url).toBeDefined();
  expect((await patch(id, { image_url: null }).expect(200)).body.data.image_url).toBeNull();
  await patch(id, { image_url: "/menu/1.png" }).expect(400);
  await db.query("UPDATE menus SET image_url = '/menu/1.png' WHERE id = ?", [id]);
  expect((await patch(id, { image_url: "" }).expect(200)).body.data.image_url).toBeNull();
});

test("BE-01: penjual B PATCH menu A → 404, menu A utuh; id aneh → 404", async () => {
  const id = await sisipMenu(idA);
  const before = await menuRow(id);
  const r = await patch(id, { name: "Dibajak", price: 50000 }, tB).expect(404);
  expect(r.body.error).toMatchObject({ code: "NOT_FOUND", message: "Menu tidak ditemukan." });
  expect(await menuRow(id)).toEqual(before);
  await request(app).patch("/api/v1/merchant/menus/abc").set("Authorization", `Bearer ${tA}`).send({ name: "x" }).expect(404);
});

test("ubah menu menggeser updated_at (checklist F18)", async () => {
  const id = await sisipMenu(idA, { updated_at: "2026-01-01 00:00:00" });
  await patch(id, { name: "Ganti" }).expect(200);
  expect((await menuRow(id)).updated_at.toISOString()).not.toBe("2026-01-01T00:00:00.000Z");
  const id2 = await sisipMenu(idA, { updated_at: "2026-01-01 00:00:00" });
  await patch(id2, { options: [{ name: "Keju", extra_price: 0 }] }).expect(200);
  expect((await menuRow(id2)).updated_at.toISOString()).not.toBe("2026-01-01T00:00:00.000Z");
});
