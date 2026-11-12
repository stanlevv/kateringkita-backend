import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { loginLimiter } from "../src/middleware/rateLimiter";
import { dalamTransaksi } from "../src/services/admin-audit.service";
import { transisi } from "../src/services/pesanan-status.service";
import { pembeliBaru, pesanDulu, siapCheckout } from "./helpers/toko";

// F08 Task 3: GET /me/notifications & POST /me/notifications/read (C-21, R-10; D13, D14)
let s: Awaited<ReturnType<typeof siapCheckout>>;
let tAni: string;
let budi: number;
let ani: number;
let siti: number;
let ids: { b1: number; b2: number; b3: number; a1: number };
const DIBACA = new Date("2026-01-02T03:04:05Z");

const get = (q = "", token: string | null = s.tCust) => {
  const r = request(app).get(`/api/v1/me/notifications${q}`);
  return token ? r.set("Authorization", `Bearer ${token}`) : r;
};
const tandai = (body?: unknown, token: string | null = s.tCust) => {
  const r = request(app).post("/api/v1/me/notifications/read");
  const t = token ? r.set("Authorization", `Bearer ${token}`) : r;
  return body === undefined ? t : t.send(body as object);
};
const sisip = async (userId: number, title: string, created: string, readAt: Date | null = null, type = "order_status") => {
  const [r] = await db.query<any>(
    "INSERT INTO notifications (user_id, type, title, body, data, read_at, created_at) VALUES (?, ?, ?, 'isi', ?, ?, ?)",
    [userId, type, title, JSON.stringify({ order_code: "KK-X", status: "confirmed" }), readAt, created],
  );
  return r.insertId as number;
};
const readAt = async (id: number) => ((await db.query<any[]>("SELECT read_at FROM notifications WHERE id = ?", [id]))[0] as any[])[0].read_at;

beforeAll(async () => {
  s = await siapCheckout();
  tAni = await pembeliBaru(1);
  const id = async (email: string) => Number(((await db.query<any[]>("SELECT id FROM users WHERE email = ?", [email]))[0] as any[])[0].id);
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
    const r = await get().expect(200);
    expect(r.body.data.map((x: any) => x.title)).toEqual(["Tiga", "Dua", "Satu"]);
    expect(Object.keys(r.body.data[0]).sort()).toEqual(["body", "created_at", "data", "id", "read_at", "title", "type"]);
    expect(r.body.data[0]).toMatchObject({ id: ids.b3, type: "order_status", data: { order_code: "KK-X", status: "confirmed" }, read_at: null });
    expect(r.body.data[0].created_at).toBe("2026-01-01T03:00:00.000Z");
    expect(r.body.data[1].read_at).toBe(DIBACA.toISOString());
    expect(r.body.meta).toEqual({ page: 1, limit: 20, total: 3, unread_count: 2 });
  });

  test("notifikasi dari transisi nyata ikut tampil", async () => {
    const code = await pesanDulu(s.tCust, s.menu);
    await dalamTransaksi((c) => transisi(c, code, "confirm", { jenis: "merchant", userId: siti, merchantId: s.idA }));
    const r = await get().expect(200);
    expect(r.body.data[0]).toMatchObject({ title: "Pesanan dikonfirmasi", data: { order_code: code, status: "confirmed" } });
    expect(r.body.meta.unread_count).toBe(3);
    await db.query("UPDATE orders SET status = 'cancelled' WHERE code = ?", [code]);
  });

  test("filter unread & halaman", async () => {
    let r = await get("?unread=true").expect(200);
    expect(r.body.data.map((x: any) => x.title)).toEqual(["Tiga", "Satu"]);
    expect(r.body.meta).toMatchObject({ total: 2, unread_count: 2 });
    r = await get("?unread=false").expect(200);
    expect(r.body.data).toHaveLength(3);
    r = await get("?page=2&limit=1").expect(200);
    expect(r.body.data.map((x: any) => x.title)).toEqual(["Dua"]);
    expect(r.body.meta).toEqual({ page: 2, limit: 1, total: 3, unread_count: 2 });
  });

  test("filter type (tab Pesanan/Promo/Info), bisa digabung unread; total ikut filter, unread_count tetap semua (D13)", async () => {
    const promo = await sisip(budi, "Promo", "2026-01-01 05:00:00", null, "promo");
    await sisip(budi, "Promo lama", "2026-01-01 00:30:00", DIBACA, "promo");
    await sisip(budi, "Info", "2026-01-01 06:00:00", null, "info");
    await sisip(ani, "Promo Ani", "2026-01-01 07:00:00", null, "promo");
    const judul = (r: request.Response) => r.body.data.map((x: any) => x.title);
    // belum dibaca Budi: Satu, Tiga, Promo, Info
    let r = await get("?type=promo").expect(200);
    expect(judul(r)).toEqual(["Promo", "Promo lama"]);
    expect(r.body.data[0]).toMatchObject({ id: promo, type: "promo", read_at: null });
    expect(r.body.meta).toEqual({ page: 1, limit: 20, total: 2, unread_count: 4 });
    r = await get("?type=promo&unread=true").expect(200);
    expect(judul(r)).toEqual(["Promo"]);
    expect(r.body.meta).toEqual({ page: 1, limit: 20, total: 1, unread_count: 4 });
    r = await get("?type=order_status").expect(200);
    expect(judul(r)).toEqual(["Tiga", "Dua", "Satu"]);
    expect(r.body.meta.total).toBe(3);
    r = await get("?unread=true&type=order_status&page=2&limit=1").expect(200);
    expect(judul(r)).toEqual(["Satu"]);
    expect(r.body.meta).toEqual({ page: 2, limit: 1, total: 2, unread_count: 4 });
    r = await get("?type=info&unread=false").expect(200);
    expect(judul(r)).toEqual(["Info"]);
    expect(r.body.meta).toMatchObject({ total: 1, unread_count: 4 });
    // tanpa type: semua tipe
    r = await get().expect(200);
    expect(judul(r)).toEqual(["Info", "Promo", "Tiga", "Dua", "Satu", "Promo lama"]);
    expect(r.body.meta).toMatchObject({ total: 6, unread_count: 4 });
    // milik orang lain tidak ikut; penjual tanpa notifikasi → kosong
    expect(judul(await get("?type=promo", tAni).expect(200))).toEqual(["Promo Ani"]);
    expect((await get("?type=promo", s.tA).expect(200)).body).toEqual({ data: [], meta: { page: 1, limit: 20, total: 0, unread_count: 0 } });
  });

  test("galat validasi", async () => {
    let r = await get("?unread=ya").expect(400);
    expect(r.body.error).toMatchObject({ code: "VALIDATION_ERROR", message: "Data tidak valid.", fields: { unread: ["Filter tidak valid."] } });
    // hanya tipe yang benar-benar ditulis ke notifications; huruf besar, kosong, dan ganda ditolak
    for (const q of ["?type=system", "?type=PROMO", "?type=", "?type=promo&type=info"]) {
      r = await get(q).expect(400);
      expect(r.body.error).toMatchObject({ code: "VALIDATION_ERROR", fields: { type: ["Tipe notifikasi tidak dikenal."] } });
    }
    r = await get("?limit=0").expect(400);
    expect(r.body.error.fields.limit).toEqual(["Halaman tidak valid."]);
    r = await get("?page=x").expect(400);
    expect(r.body.error.fields.page).toEqual(["Halaman tidak valid."]);
  });

  test("penjual → daftar kosong; tanpa token → 401", async () => {
    const r = await get("", s.tA).expect(200);
    expect(r.body).toEqual({ data: [], meta: { page: 1, limit: 20, total: 0, unread_count: 0 } });
    expect((await get("", null)).status).toBe(401);
    expect((await tandai({ all: true }, null)).status).toBe(401);
  });
});

describe("POST /me/notifications/read (D14)", () => {
  test("ids: milik orang lain/tak dikenal diabaikan", async () => {
    const r = await tandai({ ids: [ids.b1, ids.a1, 999999] }).expect(200);
    expect(r.body).toEqual({ data: { unread_count: 1 } });
    expect(await readAt(ids.b1)).toBeInstanceOf(Date);
    expect(await readAt(ids.a1)).toBeNull();
  });

  test("all: hanya milik sendiri, read_at lama tidak tertimpa", async () => {
    const r = await tandai({ all: true }).expect(200);
    expect(r.body).toEqual({ data: { unread_count: 0 } });
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
  ])("400 %s", async (_n, body, pesan) => {
    const r = await tandai(body).expect(400);
    expect(r.body.error).toMatchObject({ code: "VALIDATION_ERROR", message: "Data tidak valid." });
    expect(r.body.error.fields.ids).toContain(pesan);
  });

  test("all: false → 400", async () => {
    const r = await tandai({ all: false }).expect(400);
    expect(r.body.error.code).toBe("VALIDATION_ERROR");
  });
});
