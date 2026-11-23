import request from "supertest";
import { beforeEach, expect, test } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { createAdmin } from "../src/scripts/create-admin";
import { login, menuRow, prepareMerchants, insertMenu } from "./helpers/merchant";

let tokenA: string, tokenB: string, idA: number;

const kuota = (id: number, body: object, token = tokenA) =>
  request(app).patch(`/api/v1/merchant/menus/${id}/quota`).set("Authorization", `Bearer ${token}`).send(body);

beforeEach(async () => {
  ({ tokenA, tokenB, idA } = await prepareMerchants());
});

test("delta & quota_today mengubah kuota hari ini", async () => {
  const id = await insertMenu(idA, { quota_today: 10, sold_today: 2 });
  const res = await kuota(id, { delta: 1 }).expect(200);
  expect(res.body.data).toMatchObject({ id, quota_today: 11, available: 9, daily_quota: 20 });
  expect(Object.keys(res.body.data)).toContain("hpp");
  expect((await kuota(id, { quota_today: 20 }).expect(200)).body.data.quota_today).toBe(20);
});

test("tidak bisa di bawah porsi yang sudah dipesan → 409", async () => {
  const id = await insertMenu(idA, { quota_today: 10, sold_today: 3, held_today: 2 });
  const res = await kuota(id, { quota_today: 4 }).expect(409);
  expect(res.body.error).toEqual({
    code: "CONFLICT",
    message: "Kuota tidak bisa di bawah porsi yang sudah dipesan (5).",
  });
  expect((await kuota(id, { quota_today: 5 }).expect(200)).body.data.available).toBe(0);
  await kuota(id, { delta: -1 }).expect(409);
  expect((await menuRow(id)).quota_today).toBe(5);
  const nol = await insertMenu(idA, { quota_today: 0 });
  const neg = await kuota(nol, { delta: -1 }).expect(409); // tidak pernah negatif
  expect(neg.body.error).toEqual({ code: "CONFLICT", message: "Kuota tidak bisa kurang dari 0." });
  expect((await kuota(id, { delta: -6 }).expect(409)).body.error.message).toBe("Kuota tidak bisa kurang dari 0.");
});

test("validasi body kuota", async () => {
  const id = await insertMenu(idA, { quota_today: 5 });
  for (const body of [
    {},
    { delta: 0 },
    { delta: 1, quota_today: 2 },
    { delta: "1" },
    { quota_today: -1 },
    { delta: 1.5 },
    { delta: 10001 },
  ]) {
    const res = await kuota(id, body).expect(400);
    expect(res.body.error.message).toBe("Data kuota tidak valid.");
  }
  expect((await kuota(id, { delta: 1, quota_today: 2 })).body.error.fields).toBeUndefined();
  expect((await kuota(id, { quota_today: -1 })).body.error.fields.quota_today).toEqual(["Kuota hari ini minimal 0."]);
  const besar = await kuota(id, { quota_today: 10001 }).expect(400);
  expect(besar.body.error.fields.quota_today).toEqual(["Kuota hari ini maksimal 10.000."]);
  const hasil = await kuota(await insertMenu(idA, { quota_today: 9999 }), { delta: 2 }).expect(400);
  expect(hasil.body.error.fields.quota_today).toEqual(["Kuota hari ini maksimal 10.000."]);
});

test("reset harian sebelum tulis", async () => {
  const id = await insertMenu(idA, { stock_date: "2000-01-01", daily_quota: 20, quota_today: 10, sold_today: 8 });
  const res = await kuota(id, { quota_today: 0 }).expect(200);
  expect(res.body.data).toMatchObject({ quota_today: 0, sold_today: 0, held_today: 0, available: 0 });
});

test("konkurensi: 10 × −1 dengan sisa batas 2 → tepat 2 sukses; 20 × +1 tanpa lost update", async () => {
  const id = await insertMenu(idA, { quota_today: 5, held_today: 3 });
  const kurang = await Promise.all(Array.from({ length: 10 }, () => kuota(id, { delta: -1 })));
  const status = kurang.map((res) => res.status).sort();
  expect(status).toEqual([200, 200, 409, 409, 409, 409, 409, 409, 409, 409]);
  expect((await menuRow(id)).quota_today).toBe(3);
  const tambah = await Promise.all(Array.from({ length: 20 }, () => kuota(id, { delta: 1 })));
  expect(tambah.map((res) => res.status)).toEqual(Array(20).fill(200));
  expect((await menuRow(id)).quota_today).toBe(23);
});

test("ubah kuota tidak menggeser updated_at & tidak memunculkan 'diperbarui penjual'", async () => {
  await createAdmin({ phone: "081300000009", fullName: "Admin Uji", password: "rahasia123" });
  const adminToken = await login("081300000009");
  const id = await insertMenu(idA, { updated_at: "2026-01-01 00:00:00" });
  await request(app)
    .post(`/api/v1/admin/merchants/${idA}/request-fix`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ reason: "Tambah foto menu" })
    .expect(200);
  // catatan admin setelah semua perubahan penjual; perubahan berikutnya yang menggeser updated_at akan membuatnya true
  await db.query("UPDATE merchants SET updated_at = '2026-01-01 00:00:00' WHERE id = ?", [idA]);
  await db.query(
    "UPDATE admin_audit_logs SET created_at = '2026-06-01 00:00:00' WHERE action = 'merchant.request_fix'",
  );
  await kuota(id, { delta: 3 }).expect(200);
  await kuota(id, { quota_today: 7 }).expect(200);
  expect((await menuRow(id)).updated_at.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  const queueRes = await request(app)
    .get("/api/v1/admin/verification-queue")
    .set("Authorization", `Bearer ${adminToken}`)
    .expect(200);
  expect(queueRes.body.data.find((merchant: any) => merchant.id === idA).updated_after_note).toBe(false);
});

test("penjual B, menu terhapus, id aneh → 404", async () => {
  const id = await insertMenu(idA, { quota_today: 5 });
  const res = await kuota(id, { delta: 1 }, tokenB).expect(404);
  expect(res.body.error.message).toBe("Menu tidak ditemukan.");
  expect((await menuRow(id)).quota_today).toBe(5);
  await request(app).delete(`/api/v1/merchant/menus/${id}`).set("Authorization", `Bearer ${tokenA}`).expect(204);
  expect((await kuota(id, { delta: 1 }).expect(404)).body.error.message).toBe("Menu tidak ditemukan.");
  await request(app)
    .patch("/api/v1/merchant/menus/abc/quota")
    .set("Authorization", `Bearer ${tokenA}`)
    .send({ delta: 1 })
    .expect(404);
});
