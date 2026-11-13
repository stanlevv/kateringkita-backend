import fs from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { createAdmin } from "../src/scripts/create-admin";
import { tiketLimiter } from "../src/middleware/rateLimiter";
import { hariIniWib } from "../src/services/merchant-kuota.service";
import { kodeTiket } from "../src/services/tiket.service";
import { login, pembeliBaru, pesanDulu, siapCheckout } from "./helpers/toko";

// Tiket bantuan (CS) sisi pembeli: /me/tickets (kontrak tiket-kontrak.md, migrasi 012)
let s: Awaited<ReturnType<typeof siapCheckout>>;
let tLain: string;
let tAdmin: string;
let adminId: number;
let budi: number;
let kodeBudi: string;
let kodeLain: string;

const H = (t: string) => ({ Authorization: `Bearer ${t}` });
const get = (u: string, t: string) => request(app).get(`/api/v1${u}`).set(H(t));
const post = (u: string, t: string, body?: object) => {
  const r = request(app).post(`/api/v1${u}`).set(H(t));
  return body === undefined ? r : r.send(body);
};
const ISI = { category: "pembayaran", subject: "VA sudah dibayar", message: "Status belum lunas padahal sudah bayar." };
const buat = async (t = s.tCust, o: object = {}) => (await post("/me/tickets", t, { ...ISI, ...o }).expect(201)).body.data;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const KUNCI_DETAIL = [
  "category", "closed_at", "closed_by", "code", "created_at", "last_message_at", "last_sender_role", "messages", "order_code", "status", "subject",
];
const KUNCI_RINGKAS = [
  "category", "code", "created_at", "last_message_at", "last_message_preview", "last_sender_role", "order_code", "status", "subject", "unread",
];
const TIDAK_ADA = { code: "NOT_FOUND", message: "Tiket tidak ditemukan." };
const DITUTUP = { code: "TICKET_CLOSED", message: "Tiket sudah ditutup. Buat tiket baru bila masih perlu bantuan." };

const baris = async (code: string) => ((await db.query<any[]>("SELECT * FROM support_tickets WHERE code = ?", [code]))[0] as any[])[0];
const jumlahTiket = async () => Number(((await db.query<any[]>("SELECT COUNT(*) AS n FROM support_tickets"))[0] as any[])[0].n);
// waktu (UTC) tiket dan semua pesannya diatur agar urutan & penanda belum dibaca pasti
const setWaktu = async (code: string, ts: string) => {
  await db.query("UPDATE support_ticket_messages m JOIN support_tickets t ON t.id = m.ticket_id SET m.created_at = ? WHERE t.code = ?", [ts, code]);
  await db.query("UPDATE support_tickets SET created_at = ?, last_message_at = ? WHERE code = ?", [ts, ts, code]);
};
// balasan admin langsung lewat SQL (endpoint admin diuji di admin-tiket.test.ts)
const balasanAdmin = async (code: string, body: string, ts: string | Date) => {
  const { id } = await baris(code);
  await db.query(
    "INSERT INTO support_ticket_messages (ticket_id, sender_role, sender_user_id, body, created_at) VALUES (?, 'admin', ?, ?, ?)",
    [id, adminId, body, ts],
  );
  await db.query("UPDATE support_tickets SET status = 'answered', last_message_at = ? WHERE id = ?", [ts, id]);
};

beforeAll(async () => {
  s = await siapCheckout();
  tLain = await pembeliBaru(1);
  adminId = (await createAdmin({ phone: "081300000009", fullName: "Admin Rahasia", password: "rahasia123" })).id;
  tAdmin = await login("081300000009");
  const [[u]] = await db.query<any[]>("SELECT id FROM users WHERE email = 'budi@mail.com'");
  budi = u.id;
  kodeBudi = await pesanDulu(s.tCust, s.menu);
  kodeLain = await pesanDulu(tLain, s.menu);
});
beforeEach(async () => {
  await db.query("DELETE FROM support_tickets");
  tiketLimiter.reset();
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("migrasi 012_tiket_bantuan", () => {
  test("FK: tiket ikut terhapus bersama pembeli, pesanan/pengirim dihapus → NULL; dijalankan ulang aman", async () => {
    const [rows] = await db.query<any[]>(
      `SELECT TABLE_NAME AS t, REFERENCED_TABLE_NAME AS ref, DELETE_RULE AS aturan FROM information_schema.REFERENTIAL_CONSTRAINTS
       WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME IN ('support_tickets', 'support_ticket_messages') ORDER BY t, ref`,
    );
    expect(rows.map((r: any) => `${r.t}>${r.ref}:${r.aturan}`)).toEqual([
      "support_ticket_messages>support_tickets:CASCADE", "support_ticket_messages>users:SET NULL",
      "support_tickets>orders:SET NULL", "support_tickets>users:CASCADE",
    ]);
    const conn = await mysql.createConnection({ uri: process.env.DATABASE_URL!, multipleStatements: true });
    try {
      const sql = fs.readFileSync(path.join(__dirname, "../database/migrations/012_tiket_bantuan.sql"), "utf8");
      await expect(conn.query(sql)).resolves.toBeDefined();
    } finally {
      await conn.end();
    }
  });
});

describe("POST /me/tickets", () => {
  test("201 TicketDetail: kode TK-<tanggal WIB>-XXXX, teks dirapikan, pesanan milik sendiri", async () => {
    const r = await post("/me/tickets", s.tCust, {
      category: "pembayaran", subject: "  VA sudah dibayar  ", message: "  Status belum lunas padahal sudah bayar.  ", order_code: kodeBudi,
    }).expect(201);
    const d = r.body.data;
    expect(Object.keys(d).sort()).toEqual(KUNCI_DETAIL);
    expect(d.code).toMatch(new RegExp(`^TK-${hariIniWib().replace(/-/g, "")}-[2-9A-HJ-NP-Z]{4}$`));
    expect(d).toMatchObject({
      category: "pembayaran", subject: "VA sudah dibayar", status: "open", order_code: kodeBudi, last_sender_role: "customer",
      closed_at: null, closed_by: null,
    });
    expect(d.created_at).toMatch(ISO);
    expect(d.last_message_at).toMatch(ISO);
    expect(d.messages).toEqual([
      { id: expect.any(Number), sender_role: "customer", sender_name: null, body: "Status belum lunas padahal sudah bayar.", created_at: d.last_message_at },
    ]);
    const t = await baris(d.code);
    const [[o]] = await db.query<any[]>("SELECT id FROM orders WHERE code = ?", [kodeBudi]);
    expect(t).toMatchObject({ user_id: budi, order_id: o.id, status: "open", customer_last_read_at: null, closed_at: null, closed_by: null });
  });

  test("order_code kosong/tidak diisi → order_code null", async () => {
    expect((await buat(s.tCust, { order_code: "" })).order_code).toBeNull();
    expect((await buat(s.tCust, { order_code: null })).order_code).toBeNull();
    expect((await buat()).order_code).toBeNull();
  });

  test("validasi: pesan per field, batas panjang setelah trim", async () => {
    const SEMUA = { category: ["Pilih kategori."], subject: ["Judul 3–120 karakter."], message: ["Pesan 5–2000 karakter."] };
    expect((await post("/me/tickets", s.tCust).expect(400)).body.error).toMatchObject({ code: "VALIDATION_ERROR", fields: SEMUA });
    expect((await post("/me/tickets", s.tCust, {}).expect(400)).body.error.fields).toEqual(SEMUA);
    const salah = async (o: object) => (await post("/me/tickets", s.tCust, { ...ISI, ...o }).expect(400)).body.error.fields;
    expect(await salah({ category: "lain" })).toEqual({ category: SEMUA.category });
    expect(await salah({ category: "Akun" })).toEqual({ category: SEMUA.category });
    expect(await salah({ subject: "  ab  " })).toEqual({ subject: SEMUA.subject });
    expect(await salah({ subject: "x".repeat(121) })).toEqual({ subject: SEMUA.subject });
    expect(await salah({ subject: 123 })).toEqual({ subject: SEMUA.subject });
    expect(await salah({ message: "  abcd  " })).toEqual({ message: SEMUA.message });
    expect(await salah({ message: "x".repeat(2001) })).toEqual({ message: SEMUA.message });
    expect(await salah({ order_code: 12 })).toEqual({ order_code: ["Pesanan tidak ditemukan."] });
    expect(await jumlahTiket()).toBe(0);
    // batas tepat lolos; semua kategori diterima
    await buat(s.tCust, { category: "akun", subject: "abc", message: "abcde" });
    await buat(s.tCust, { category: "lainnya", subject: "x".repeat(120), message: "y".repeat(2000) });
    for (const category of ["pesanan", "penjual", "aplikasi"]) {
      const { code } = await buat(s.tCust, { category });
      await post(`/me/tickets/${code}/close`, s.tCust).expect(200);
    }
  });

  test("order_code milik pembeli lain / tidak ada → 400 fields.order_code, tidak ada tiket", async () => {
    for (const order_code of [kodeLain, "KK-20000101-ZZZZ"]) {
      const r = await post("/me/tickets", s.tCust, { ...ISI, order_code }).expect(400);
      expect(r.body.error).toMatchObject({ code: "VALIDATION_ERROR", fields: { order_code: ["Pesanan tidak ditemukan."] } });
    }
    expect(await jumlahTiket()).toBe(0);
    expect((await buat(tLain, { order_code: kodeLain })).order_code).toBe(kodeLain);
  });

  test("maks 3 tiket belum ditutup (open/answered) → 409; tutup satu → boleh lagi; pembeli lain tidak terpengaruh", async () => {
    const [a] = [await buat(), await buat(), await buat()];
    await db.query("UPDATE support_tickets SET status = 'answered' WHERE code = ?", [a.code]);
    const r = await post("/me/tickets", s.tCust, ISI).expect(409);
    expect(r.body.error).toEqual({
      code: "TOO_MANY_OPEN_TICKETS", message: "Masih ada 3 tiket yang belum selesai. Tunggu balasan atau tutup salah satunya.",
    });
    await buat(tLain);
    await post(`/me/tickets/${a.code}/close`, s.tCust).expect(200);
    await buat();
    await post("/me/tickets", s.tCust, ISI).expect(409);
    expect(await jumlahTiket()).toBe(5);
  });

  test("kode bentrok → coba kode acak lain", async () => {
    const spy = vi.spyOn(kodeTiket, "acak").mockReturnValueOnce("AAAA").mockReturnValueOnce("AAAA").mockReturnValueOnce("BBBB");
    try {
      const a = await buat();
      const b = await buat();
      expect(a.code.endsWith("-AAAA")).toBe(true);
      expect(b.code.endsWith("-BBBB")).toBe(true);
      expect(spy).toHaveBeenCalledTimes(3);
    } finally {
      spy.mockRestore();
    }
  });

  test("batas laju 10 tiket baru per jam; permintaan gagal tidak dihitung", async () => {
    await post("/me/tickets", s.tCust, {}).expect(400);
    await post("/me/tickets", s.tCust, { ...ISI, order_code: kodeLain }).expect(400);
    for (let i = 0; i < 10; i++) {
      const { code } = await buat();
      await post(`/me/tickets/${code}/close`, s.tCust).expect(200);
    }
    const r = await post("/me/tickets", s.tCust, ISI).expect(429);
    expect(r.body.error.code).toBe("RATE_LIMITED");
    await buat(tLain);
  });
});

describe("GET /me/tickets", () => {
  test("urut pesan terakhir terbaru, ringkasan, unread & unread_count, halaman, hanya milik sendiri", async () => {
    const [t1, t2, t3] = [await buat(s.tCust, { order_code: kodeBudi }), await buat(), await buat()];
    const lain = await buat(tLain);
    for (const t of [t1, t2, t3, lain]) await setWaktu(t.code, "2025-12-31 00:00:00");
    await setWaktu(t2.code, "2026-01-02 00:00:00");
    const panjang = `Halo kak, ${"dana sudah masuk ".repeat(10)}`;
    // t1: dibaca 01-02, admin membalas 01-03 → belum dibaca; t3: admin membalas 01-01, dibaca sesudahnya → sudah
    await db.query("UPDATE support_tickets SET customer_last_read_at = '2026-01-02 00:00:00' WHERE code = ?", [t1.code]);
    await balasanAdmin(t1.code, panjang, "2026-01-03 00:00:00");
    await balasanAdmin(t3.code, "Sudah kami cek.", "2026-01-01 00:00:00");
    await db.query("UPDATE support_tickets SET customer_last_read_at = '2026-01-01 00:00:01' WHERE code = ?", [t3.code]);
    await balasanAdmin(lain.code, "Untuk pembeli lain.", "2026-01-05 00:00:00");

    const r = await get("/me/tickets", s.tCust).expect(200);
    expect(r.body.meta).toEqual({ page: 1, limit: 20, total: 3, unread_count: 1 });
    expect(r.body.data.map((t: any) => t.code)).toEqual([t1.code, t2.code, t3.code]);
    for (const t of r.body.data) expect(Object.keys(t).sort()).toEqual(KUNCI_RINGKAS);
    expect(r.body.data[0]).toEqual({
      code: t1.code, category: "pembayaran", subject: "VA sudah dibayar", status: "answered", order_code: kodeBudi,
      created_at: "2025-12-31T00:00:00.000Z", last_message_at: "2026-01-03T00:00:00.000Z",
      last_message_preview: panjang.slice(0, 100), last_sender_role: "admin", unread: true,
    });
    expect(r.body.data[1]).toMatchObject({
      status: "open", order_code: null, last_message_preview: ISI.message, last_sender_role: "customer", unread: false,
    });
    expect(r.body.data[2]).toMatchObject({ status: "answered", last_message_preview: "Sudah kami cek.", last_sender_role: "admin", unread: false });
    expect(JSON.stringify(r.body)).not.toContain("Untuk pembeli lain.");

    const h2 = await get("/me/tickets?limit=2&page=2", s.tCust).expect(200);
    expect(h2.body.meta).toEqual({ page: 2, limit: 2, total: 3, unread_count: 1 });
    expect(h2.body.data.map((t: any) => t.code)).toEqual([t3.code]);
    // limit ≤ 50; nilai tak valid → bawaan
    expect((await get("/me/tickets?limit=500", s.tCust).expect(200)).body.meta.limit).toBe(50);
    expect((await get("/me/tickets?limit=abc&page=0", s.tCust).expect(200)).body.meta).toMatchObject({ page: 1, limit: 20 });

    const l = await get("/me/tickets", tLain).expect(200);
    expect(l.body.data.map((t: any) => t.code)).toEqual([lain.code]);
    expect(l.body.meta).toEqual({ page: 1, limit: 20, total: 1, unread_count: 1 });
  });

  test("tanpa tiket → daftar kosong", async () => {
    const r = await get("/me/tickets", s.tCust).expect(200);
    expect(r.body).toEqual({ data: [], meta: { page: 1, limit: 20, total: 0, unread_count: 0 } });
  });
});

describe("GET /me/tickets/:code", () => {
  test("menandai dibaca; nama admin asli tidak dikirim; pesan urut kirim", async () => {
    const t = await buat();
    await setWaktu(t.code, "2026-01-01 00:00:00");
    await balasanAdmin(t.code, "Halo, sudah kami cek.", "2026-01-01 01:00:00");
    expect((await get("/me/tickets", s.tCust).expect(200)).body.meta.unread_count).toBe(1);

    const r = await get(`/me/tickets/${t.code}`, s.tCust).expect(200);
    expect(Object.keys(r.body.data).sort()).toEqual(KUNCI_DETAIL);
    expect(r.body.data).toMatchObject({ code: t.code, status: "answered", last_sender_role: "admin", last_message_at: "2026-01-01T01:00:00.000Z" });
    expect(r.body.data.messages).toEqual([
      { id: expect.any(Number), sender_role: "customer", sender_name: null, body: ISI.message, created_at: "2026-01-01T00:00:00.000Z" },
      { id: expect.any(Number), sender_role: "admin", sender_name: "Tim KateringKita", body: "Halo, sudah kami cek.", created_at: "2026-01-01T01:00:00.000Z" },
    ]);
    expect(JSON.stringify(r.body)).not.toContain("Admin Rahasia");
    expect((await baris(t.code)).customer_last_read_at).not.toBeNull();
    const l = await get("/me/tickets", s.tCust).expect(200);
    expect(l.body.meta.unread_count).toBe(0);
    expect(l.body.data[0].unread).toBe(false);

    // balasan admin setelah dibaca → belum dibaca lagi
    await balasanAdmin(t.code, "Ada tambahan.", new Date(Date.now() + 3600e3));
    expect((await get("/me/tickets", s.tCust).expect(200)).body.data[0].unread).toBe(true);
  });

  test("tiket pembeli lain / tidak ada → 404, tidak ditandai dibaca", async () => {
    const lain = await buat(tLain);
    for (const code of [lain.code, "TK-20000101-ZZZZ"]) {
      expect((await get(`/me/tickets/${code}`, s.tCust).expect(404)).body.error).toMatchObject(TIDAK_ADA);
      expect((await post(`/me/tickets/${code}/messages`, s.tCust, { body: "Halo" }).expect(404)).body.error).toMatchObject(TIDAK_ADA);
      expect((await post(`/me/tickets/${code}/close`, s.tCust).expect(404)).body.error).toMatchObject(TIDAK_ADA);
    }
    expect(await baris(lain.code)).toMatchObject({ status: "open", customer_last_read_at: null, closed_at: null });
    expect((await get(`/me/tickets/${lain.code}`, tLain).expect(200)).body.data.messages).toHaveLength(1);
  });
});

describe("balas & tutup (pembeli)", () => {
  test("balas: 201 TicketDetail, status kembali open, last_message_at maju; validasi 1–2000", async () => {
    const t = await buat();
    await setWaktu(t.code, "2026-01-01 00:00:00");
    await balasanAdmin(t.code, "Mohon kirim bukti bayar.", "2026-01-01 01:00:00");

    const r = await post(`/me/tickets/${t.code}/messages`, s.tCust, { body: "  Sudah saya kirim.  " }).expect(201);
    const d = r.body.data;
    expect(Object.keys(d).sort()).toEqual(KUNCI_DETAIL);
    expect(d).toMatchObject({ status: "open", last_sender_role: "customer" });
    expect(d.messages.map((m: any) => [m.sender_role, m.body])).toEqual([
      ["customer", ISI.message], ["admin", "Mohon kirim bukti bayar."], ["customer", "Sudah saya kirim."],
    ]);
    expect(d.last_message_at).toBe(d.messages[2].created_at);
    expect(Date.parse(d.last_message_at)).toBeGreaterThan(Date.parse("2026-01-01T01:00:00Z"));

    const PESAN = { body: ["Pesan 1–2000 karakter."] };
    for (const body of [{}, { body: "   " }, { body: "x".repeat(2001) }, { body: 5 }]) {
      const e = await post(`/me/tickets/${t.code}/messages`, s.tCust, body).expect(400);
      expect(e.body.error).toMatchObject({ code: "VALIDATION_ERROR", fields: PESAN });
    }
    await post(`/me/tickets/${t.code}/messages`, s.tCust).expect(400);
    await post(`/me/tickets/${t.code}/messages`, s.tCust, { body: "y" }).expect(201);
    await post(`/me/tickets/${t.code}/messages`, s.tCust, { body: "z".repeat(2000) }).expect(201);
    expect((await get(`/me/tickets/${t.code}`, s.tCust).expect(200)).body.data.messages).toHaveLength(5);
  });

  test("tutup: 200 closed oleh customer; ulang tanpa perubahan; balas tiket tertutup 409", async () => {
    const t = await buat();
    const r = await post(`/me/tickets/${t.code}/close`, s.tCust).expect(200);
    expect(Object.keys(r.body.data).sort()).toEqual(KUNCI_DETAIL);
    expect(r.body.data).toMatchObject({ code: t.code, status: "closed", closed_by: "customer" });
    expect(r.body.data.closed_at).toMatch(ISO);

    await db.query("UPDATE support_tickets SET closed_at = '2026-01-01 00:00:00' WHERE code = ?", [t.code]);
    const ulang = await post(`/me/tickets/${t.code}/close`, s.tCust).expect(200);
    expect(ulang.body.data).toMatchObject({ status: "closed", closed_by: "customer", closed_at: "2026-01-01T00:00:00.000Z" });

    const e = await post(`/me/tickets/${t.code}/messages`, s.tCust, { body: "Masih ada masalah." }).expect(409);
    expect(e.body.error).toEqual(DITUTUP);
    expect((await get(`/me/tickets/${t.code}`, s.tCust).expect(200)).body.data.messages).toHaveLength(1);
  });

  test("tiket yang sudah ditutup admin: tutup oleh pembeli 200, closed_by tetap admin", async () => {
    const t = await buat();
    await db.query("UPDATE support_tickets SET status = 'closed', closed_by = 'admin', closed_at = '2026-01-01 00:00:00' WHERE code = ?", [t.code]);
    const r = await post(`/me/tickets/${t.code}/close`, s.tCust).expect(200);
    expect(r.body.data).toMatchObject({ status: "closed", closed_by: "admin", closed_at: "2026-01-01T00:00:00.000Z" });
  });
});

describe("akses /me/tickets", () => {
  test("penjual & admin 403, tanpa token 401", async () => {
    const t = await buat();
    for (const tok of [s.tA, tAdmin]) {
      await get("/me/tickets", tok).expect(403);
      await post("/me/tickets", tok, ISI).expect(403);
      await get(`/me/tickets/${t.code}`, tok).expect(403);
      await post(`/me/tickets/${t.code}/messages`, tok, { body: "Halo" }).expect(403);
      await post(`/me/tickets/${t.code}/close`, tok).expect(403);
    }
    await request(app).get("/api/v1/me/tickets").expect(401);
    await request(app).post("/api/v1/me/tickets").send(ISI).expect(401);
    expect(await jumlahTiket()).toBe(1);
    expect(await baris(t.code)).toMatchObject({ status: "open", customer_last_read_at: null });
  });
});
