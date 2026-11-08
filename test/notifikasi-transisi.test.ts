import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { hariIniWib } from "../src/services/merchant-kuota.service";
import { dalamTransaksi } from "../src/services/admin-audit.service";
import { Aksi, Aktor, Status, transisi } from "../src/services/pesanan-status.service";
import { pesanDulu, siapCheckout } from "./helpers/toko";

// F08 Task 1: notifikasi status pesanan di dalam transaksi transisi (C-21, R-10; D8, D10–D12)
let s: Awaited<ReturnType<typeof siapCheckout>>;
let penjual: Aktor;
let penjualB: Aktor;
let pembeli: Aktor;
let budi: number;
let siti: number;
const sistem: Aktor = { jenis: "system" };
const TOKO = "Dapur Siti";

const jalan = (code: string, aksi: Aksi, aktor: Aktor, reason?: string | null) =>
  dalamTransaksi((c) => transisi(c, code, aksi, aktor, reason));
const notif = async (userId = budi) => (await db.query<any[]>("SELECT * FROM notifications WHERE user_id = ? ORDER BY id", [userId]))[0] as any[];
const siap = async (status: Status = "holding") => {
  const code = await pesanDulu(s.tCust, s.menu, 2);
  await db.query("UPDATE orders SET status = ? WHERE code = ?", [status, code]);
  return code;
};
const lewat = (code: string) => db.query("UPDATE orders SET hold_until = UTC_TIMESTAMP() - INTERVAL 1 MINUTE WHERE code = ?", [code]);
const aksiToko = (code: string, aksi: string, body: object = {}) =>
  request(app).post(`/api/v1/merchant/orders/${code}/${aksi}`).set("Authorization", `Bearer ${s.tA}`).send(body);

beforeAll(async () => {
  s = await siapCheckout();
  const id = async (email: string) => Number(((await db.query<any[]>("SELECT id FROM users WHERE email = ?", [email]))[0] as any[])[0].id);
  budi = await id("budi@mail.com");
  siti = await id("siti@mail.com");
  penjual = { jenis: "merchant", userId: siti, merchantId: s.idA };
  penjualB = { jenis: "merchant", userId: await id("andi@mail.com"), merchantId: s.idB };
  pembeli = { jenis: "customer", userId: budi };
});
afterEach(async () => {
  await db.query("UPDATE orders SET status = 'expired' WHERE status = 'holding'");
  await db.query("UPDATE menus SET held_today = 0, sold_today = 0, sold_total = 0, stock_date = ?", [hariIniWib()]);
  await db.query("DELETE FROM notifications");
  await db.query("UPDATE merchants SET business_name = ? WHERE id = ?", [TOKO, s.idA]);
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("notifikasi untuk pembeli (D8, D12)", () => {
  test("confirm → cook → ready → complete: tepat 3 notifikasi, complete tanpa notifikasi", async () => {
    const code = await siap();
    for (const a of ["confirm", "cook", "ready", "complete"] as Aksi[]) await jalan(code, a, penjual);
    const n = await notif();
    expect(n.map((x) => x.title)).toEqual(["Pesanan dikonfirmasi", "Pesanan sedang dimasak", "Pesanan siap diambil"]);
    expect(n[0].body).toBe(`${TOKO} sudah mengonfirmasi pesanan ${code}.`);
    expect(n[1].body).toBe(`${TOKO} sedang memasak pesanan ${code}.`);
    expect(n[2].body).toBe(`Pesanan ${code} sudah siap. Silakan ambil di titik temu.`);
    expect(n[0]).toMatchObject({ type: "order_status", data: { order_code: code, status: "confirmed" }, read_at: null });
    expect(n[0].created_at).toBeInstanceOf(Date);
  });

  test("reject: judul & alasan; alasan 255 + nama toko 150 → body dipotong 255", async () => {
    const code = await siap();
    await jalan(code, "reject", penjual, "Stok habis");
    expect((await notif())[0]).toMatchObject({ title: "Pesanan ditolak", body: `${TOKO} menolak pesanan ${code}. Alasan: Stok habis` });

    await db.query("UPDATE merchants SET business_name = ? WHERE id = ?", ["T".repeat(150), s.idA]);
    const code2 = await siap();
    await expect(jalan(code2, "reject", penjual, "a".repeat(255))).resolves.toMatchObject({ ke: "cancelled" });
    expect((await notif())[1].body.length).toBe(255);
  });

  test("expire sistem → Pesanan kedaluwarsa", async () => {
    const code = await siap();
    await lewat(code);
    await jalan(code, "expire", sistem);
    expect((await notif())[0]).toMatchObject({
      title: "Pesanan kedaluwarsa",
      body: `Pesanan ${code} di ${TOKO} dibatalkan otomatis karena tidak dikonfirmasi tepat waktu.`,
      data: { order_code: code, status: "expired" },
    });
  });

  test("aksi pembeli sendiri (cancel HTTP, complete) tanpa notifikasi", async () => {
    const code = await siap();
    await request(app).post(`/api/v1/orders/${code}/cancel`).set("Authorization", `Bearer ${s.tCust}`).send({}).expect(200);
    const code2 = await siap("ready");
    await jalan(code2, "complete", pembeli);
    expect(await notif()).toEqual([]);
  });

  test("transisi gagal → tanpa notifikasi (D10)", async () => {
    const code = await siap();
    await expect(jalan(code, "cook", penjual)).rejects.toMatchObject({ status: 409 });
    await expect(jalan(code, "confirm", penjualB)).rejects.toMatchObject({ status: 404 });
    await expect(jalan(code, "expire", sistem)).rejects.toMatchObject({ status: 409 });
    await expect(jalan("KK-TIDAKADA", "expire", sistem)).rejects.toMatchObject({ status: 404 });
    expect(await notif()).toEqual([]);
  });

  test("tanpa data pembeli; penjual tidak menerima notifikasi (D9)", async () => {
    const code = await siap();
    await jalan(code, "confirm", penjual);
    const code2 = await siap();
    await jalan(code2, "reject", penjual, "Habis");
    const teks = JSON.stringify(await notif());
    expect(teks).not.toContain("081234567890");
    expect(teks).not.toContain("Budi");
    expect(await notif(siti)).toEqual([]);
  });
});

// D11: urutan kunci users → orders untuk semua aktor; tanpa itu INSERT notifikasi (FK users) membentuk siklus dengan checkout/batal pembeli
describe("balapan tanpa deadlock (D11)", () => {
  test("tolak penjual paralel dengan checkout pembeli yang sama, 5 putaran → tanpa 500", async () => {
    let ditolak = 0;
    for (let i = 0; i < 5; i++) {
      const code = await siap();
      const [r, c] = await Promise.all([
        aksiToko(code, "reject", { reason: "Habis" }),
        request(app).post("/api/v1/orders").set("Authorization", `Bearer ${s.tCust}`).set("Idempotency-Key", crypto.randomUUID())
          .send({ items: [{ menu_id: s.menu2, qty: 1 }], pickup_point_id: 1, payment_method: "cod" }),
      ]);
      expect([200, 409]).toContain(r.status);
      expect([201, 409]).toContain(c.status);
      if (r.status === 200) ditolak++;
      await db.query("UPDATE orders SET status = 'expired' WHERE status = 'holding'");
    }
    expect((await notif()).filter((x) => x.title === "Pesanan ditolak")).toHaveLength(ditolak);
    expect(ditolak).toBe(5);
  });

  test("expire sistem paralel dengan batal pembeli pada pesanan lain, 5 putaran → tanpa 500", async () => {
    for (let i = 0; i < 5; i++) {
      const tua = await siap();
      await lewat(tua);
      const baru = await siap();
      const [e, c] = await Promise.allSettled([
        jalan(tua, "expire", sistem),
        request(app).post(`/api/v1/orders/${baru}/cancel`).set("Authorization", `Bearer ${s.tCust}`).send({}),
      ]);
      expect(e.status).toBe("fulfilled");
      expect(c.status === "fulfilled" && c.value.status).toBe(200);
    }
    expect((await notif()).filter((x) => x.title === "Pesanan kedaluwarsa")).toHaveLength(5);
  });
});
