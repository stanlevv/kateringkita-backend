import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { loginLimiter } from "../src/middleware/rate-limiter";
import { withTransaction } from "../src/services/admin-audit.service";
import { transitionOrder } from "../src/services/order-status.service";
import { createCustomer, placeOrder, prepareCheckout } from "./helpers/merchant";

// F08 Task 3: GET /me/notifications & POST /me/notifications/read (C-21, R-10; D13, D14)
let setup: Awaited<ReturnType<typeof prepareCheckout>>;
let tAni: string;
let budi: number;
let ani: number;
let siti: number;
let ids: { b1: number; b2: number; b3: number; a1: number };
const DIBACA = new Date("2026-01-02T03:04:05Z");

const get = (query = "", token: string | null = setup.customerToken) => {
  const req = request(app).get(`/api/v1/me/notifications${query}`);
  return token ? req.set("Authorization", `Bearer ${token}`) : req;
};
const tandai = (body?: unknown, token: string | null = setup.customerToken) => {
  const baseReq = request(app).post("/api/v1/me/notifications/read");
  const req = token ? baseReq.set("Authorization", `Bearer ${token}`) : baseReq;
  return body === undefined ? req : req.send(body as object);
};
const sisip = async (
  userId: number,
  title: string,
  created: string,
  readAt: Date | null = null,
  type = "order_status",
) => {
  const [result] = await db.query<any>(
    "INSERT INTO notifications (user_id, type, title, body, data, read_at, created_at) VALUES (?, ?, ?, 'isi', ?, ?, ?)",
    [userId, type, title, JSON.stringify({ order_code: "KK-X", status: "confirmed" }), readAt, created],
  );
  return result.insertId as number;
};
const readAt = async (id: number) =>
  ((await db.query<any[]>("SELECT read_at FROM notifications WHERE id = ?", [id]))[0] as any[])[0].read_at;

beforeAll(async () => {
  setup = await prepareCheckout();
  tAni = await createCustomer(1);
  const id = async (email: string) =>
    Number(((await db.query<any[]>("SELECT id FROM users WHERE email = ?", [email]))[0] as any[])[0].id);
  budi = await id("budi@mail.com");
  ani = await id("pembeli1@mail.com");
  siti = await id("siti@mail.com");
});
beforeEach(async () => {
  loginLimiter.reset();
  await db.query("DELETE FROM notifications");
  ids = {
    b1: await sisip(budi, "Satu", "2026-01-01 01:00:00"),
    b2: await sisip(budi, "Dua", "2026-01-01 02:00:00", DIBACA),
    b3: await sisip(budi, "Tiga", "2026-01-01 03:00:00"),
    a1: await sisip(ani, "Ani", "2026-01-01 04:00:00"),
  };
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("GET /me/notifications (D13)", () => {
  test("milik sendiri, terbaru dulu, bentuk & meta", async () => {
    const res = await get().expect(200);
    expect(res.body.data.map((notification: any) => notification.title)).toEqual(["Tiga", "Dua", "Satu"]);
    expect(Object.keys(res.body.data[0]).sort()).toEqual([
      "body",
      "created_at",
      "data",
      "id",
      "read_at",
      "title",
      "type",
    ]);
    expect(res.body.data[0]).toMatchObject({
      id: ids.b3,
      type: "order_status",
      data: { order_code: "KK-X", status: "confirmed" },
      read_at: null,
    });
    expect(res.body.data[0].created_at).toBe("2026-01-01T03:00:00.000Z");
    expect(res.body.data[1].read_at).toBe(DIBACA.toISOString());
    expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 3, unread_count: 2 });
  });

  test("notifikasi dari transisi nyata ikut tampil", async () => {
    const code = await placeOrder(setup.customerToken, setup.menu);
    await withTransaction((conn) =>
      transitionOrder(conn, code, "confirm", { kind: "merchant", userId: siti, merchantId: setup.idA }),
    );
    const res = await get().expect(200);
    expect(res.body.data[0]).toMatchObject({
      title: "Pesanan dikonfirmasi",
      data: { order_code: code, status: "confirmed" },
    });
    expect(res.body.meta.unread_count).toBe(3);
    await db.query("UPDATE orders SET status = 'cancelled' WHERE code = ?", [code]);
  });

  test("filter unread & halaman", async () => {
    let res = await get("?unread=true").expect(200);
    expect(res.body.data.map((notification: any) => notification.title)).toEqual(["Tiga", "Satu"]);
    expect(res.body.meta).toMatchObject({ total: 2, unread_count: 2 });
    res = await get("?unread=false").expect(200);
    expect(res.body.data).toHaveLength(3);
    res = await get("?page=2&limit=1").expect(200);
    expect(res.body.data.map((notification: any) => notification.title)).toEqual(["Dua"]);
    expect(res.body.meta).toEqual({ page: 2, limit: 1, total: 3, unread_count: 2 });
  });

  test("filter type (tab Pesanan/Promo/Info), bisa digabung unread; total ikut filter, unread_count tetap semua (D13)", async () => {
    const promo = await sisip(budi, "Promo", "2026-01-01 05:00:00", null, "promo");
    await sisip(budi, "Promo lama", "2026-01-01 00:30:00", DIBACA, "promo");
    await sisip(budi, "Info", "2026-01-01 06:00:00", null, "info");
    await sisip(ani, "Promo Ani", "2026-01-01 07:00:00", null, "promo");
    const judul = (res: request.Response) => res.body.data.map((notification: any) => notification.title);
    // belum dibaca Budi: Satu, Tiga, Promo, Info
    let res = await get("?type=promo").expect(200);
    expect(judul(res)).toEqual(["Promo", "Promo lama"]);
    expect(res.body.data[0]).toMatchObject({ id: promo, type: "promo", read_at: null });
    expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 2, unread_count: 4 });
    res = await get("?type=promo&unread=true").expect(200);
    expect(judul(res)).toEqual(["Promo"]);
    expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 1, unread_count: 4 });
    res = await get("?type=order_status").expect(200);
    expect(judul(res)).toEqual(["Tiga", "Dua", "Satu"]);
    expect(res.body.meta.total).toBe(3);
    res = await get("?unread=true&type=order_status&page=2&limit=1").expect(200);
    expect(judul(res)).toEqual(["Satu"]);
    expect(res.body.meta).toEqual({ page: 2, limit: 1, total: 2, unread_count: 4 });
    res = await get("?type=info&unread=false").expect(200);
    expect(judul(res)).toEqual(["Info"]);
    expect(res.body.meta).toMatchObject({ total: 1, unread_count: 4 });
    // tanpa type: semua tipe
    res = await get().expect(200);
    expect(judul(res)).toEqual(["Info", "Promo", "Tiga", "Dua", "Satu", "Promo lama"]);
    expect(res.body.meta).toMatchObject({ total: 6, unread_count: 4 });
    // milik orang lain tidak ikut; penjual tanpa notifikasi → kosong
    expect(judul(await get("?type=promo", tAni).expect(200))).toEqual(["Promo Ani"]);
    expect((await get("?type=promo", setup.tokenA).expect(200)).body).toEqual({
      data: [],
      meta: { page: 1, limit: 20, total: 0, unread_count: 0 },
    });
  });

  test("galat validasi", async () => {
    let res = await get("?unread=ya").expect(400);
    expect(res.body.error).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Data tidak valid.",
      fields: { unread: ["Filter tidak valid."] },
    });
    // hanya tipe yang benar-benar ditulis ke notifications; huruf besar, kosong, dan ganda ditolak
    for (const query of ["?type=system", "?type=PROMO", "?type=", "?type=promo&type=info"]) {
      res = await get(query).expect(400);
      expect(res.body.error).toMatchObject({
        code: "VALIDATION_ERROR",
        fields: { type: ["Tipe notifikasi tidak dikenal."] },
      });
    }
    res = await get("?limit=0").expect(400);
    expect(res.body.error.fields.limit).toEqual(["Halaman tidak valid."]);
    res = await get("?page=x").expect(400);
    expect(res.body.error.fields.page).toEqual(["Halaman tidak valid."]);
  });

  test("penjual → daftar kosong; tanpa token → 401", async () => {
    const res = await get("", setup.tokenA).expect(200);
    expect(res.body).toEqual({ data: [], meta: { page: 1, limit: 20, total: 0, unread_count: 0 } });
    expect((await get("", null)).status).toBe(401);
    expect((await tandai({ all: true }, null)).status).toBe(401);
  });
});

describe("POST /me/notifications/read (D14)", () => {
  test("ids: milik orang lain/tak dikenal diabaikan", async () => {
    const res = await tandai({ ids: [ids.b1, ids.a1, 999999] }).expect(200);
    expect(res.body).toEqual({ data: { unread_count: 1 } });
    expect(await readAt(ids.b1)).toBeInstanceOf(Date);
    expect(await readAt(ids.a1)).toBeNull();
  });

  test("all: hanya milik sendiri, read_at lama tidak tertimpa", async () => {
    const res = await tandai({ all: true }).expect(200);
    expect(res.body).toEqual({ data: { unread_count: 0 } });
    expect((await readAt(ids.b2)).toISOString()).toBe(DIBACA.toISOString());
    expect(await readAt(ids.b3)).toBeInstanceOf(Date);
    expect(await readAt(ids.a1)).toBeNull();
    expect((await get("", tAni)).body.meta.unread_count).toBe(1);
  });

  const PILIH = "Pilih notifikasi yang ditandai.";
  const NOTIF = "Notifikasi tidak valid.";
  test.each([
    ["{}", {}, PILIH],
    ["tanpa body", undefined, PILIH],
    ["ids kosong", { ids: [] }, PILIH],
    ["ids + all", { ids: [1], all: true }, PILIH],
    ["ids teks", { ids: ["a"] }, NOTIF],
    ["ids 0", { ids: [0] }, NOTIF],
    ["ids pecahan", { ids: [1.5] }, NOTIF],
    ["101 elemen", { ids: Array.from({ length: 101 }, (_, i) => i + 1) }, NOTIF],
  ])("400 %s", async (_label, body, pesan) => {
    const res = await tandai(body).expect(400);
    expect(res.body.error).toMatchObject({ code: "VALIDATION_ERROR", message: "Data tidak valid." });
    expect(res.body.error.fields.ids).toContain(pesan);
  });

  test("all: false → 400", async () => {
    const res = await tandai({ all: false }).expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});
