import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { createAdmin } from "../src/scripts/create-admin";
import { tiketLimiter } from "../src/middleware/rateLimiter";
import { login, pembeliBaru, pesanDulu, siapCheckout } from "./helpers/toko";

// Tiket bantuan (CS) sisi admin: /admin/tickets (kontrak tiket-kontrak.md); semua tingkat admin boleh baca & balas
let s: Awaited<ReturnType<typeof siapCheckout>>;
let tLain: string;
let tSuper: string;
let tOps: string;
let tSupport: string;
let superId: number;
let supportId: number;
let budi: number;
let lainId: number;
let kodeBudi: string;

const H = (t: string) => ({ Authorization: `Bearer ${t}` });
const get = (u: string, t: string) => request(app).get(`/api/v1${u}`).set(H(t));
const post = (u: string, t: string, body?: object) => {
  const r = request(app).post(`/api/v1${u}`).set(H(t));
  return body === undefined ? r : r.send(body);
};
const ISI = { category: "pembayaran", subject: "VA sudah dibayar", message: "Status belum lunas padahal sudah bayar." };
const buat = async (t: string, o: object = {}) => (await post("/me/tickets", t, { ...ISI, ...o }).expect(201)).body.data.code as string;
const kode = (r: request.Response) => r.body.data.map((t: any) => t.code);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const KUNCI_RINGKAS = [
  "category", "code", "created_at", "customer", "last_message_at", "last_message_preview", "last_sender_role", "order_code", "status", "subject",
];
const KUNCI_DETAIL = [
  "category", "closed_at", "closed_by", "code", "created_at", "customer", "last_message_at", "last_sender_role", "messages", "order",
  "order_code", "status", "subject",
];
const DITUTUP = { code: "TICKET_CLOSED", message: "Tiket sudah ditutup. Buat tiket baru bila masih perlu bantuan." };

const baris = async (code: string) => ((await db.query<any[]>("SELECT * FROM support_tickets WHERE code = ?", [code]))[0] as any[])[0];
const notifs = async (userId: number) =>
  (await db.query<any[]>("SELECT type, title, body, data FROM notifications WHERE user_id = ? ORDER BY id", [userId]))[0] as any[];
const audit = async () =>
  (await db.query<any[]>("SELECT admin_user_id, action, target_type, target_id, before_json, after_json FROM admin_audit_logs ORDER BY id"))[0] as any[];
const atur = (code: string, status: string, ts: string) =>
  db.query("UPDATE support_tickets SET status = ?, last_message_at = ? WHERE code = ?", [status, ts, code]);

beforeAll(async () => {
  s = await siapCheckout();
  tLain = await pembeliBaru(1);
  superId = (await createAdmin({ phone: "081300000009", fullName: "Admin Super", password: "rahasia123" })).id;
  await createAdmin({ phone: "081300000010", fullName: "Admin Ops", password: "rahasia123" });
  supportId = (await createAdmin({ phone: "081300000011", fullName: "Admin Support", password: "rahasia123" })).id;
  await db.query("UPDATE users SET admin_level = 'ops' WHERE phone = '081300000010'");
  await db.query("UPDATE users SET admin_level = 'support' WHERE phone = '081300000011'");
  [tSuper, tOps, tSupport] = [await login("081300000009"), await login("081300000010"), await login("081300000011")];
  const [u] = await db.query<any[]>("SELECT id, email FROM users WHERE email IN ('budi@mail.com', 'pembeli1@mail.com')");
  budi = u.find((r: any) => r.email === "budi@mail.com").id;
  lainId = u.find((r: any) => r.email === "pembeli1@mail.com").id;
  kodeBudi = await pesanDulu(s.tCust, s.menu);
});
beforeEach(async () => {
  await db.query("DELETE FROM support_tickets");
  await db.query("DELETE FROM notifications");
  await db.query("DELETE FROM admin_audit_logs");
  tiketLimiter.reset();
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("GET /admin/tickets", () => {
  let a: string, b: string, c: string, d: string;
  beforeEach(async () => {
    a = await buat(s.tCust, { subject: "VA belum lunas", order_code: kodeBudi });
    b = await buat(s.tCust, { category: "aplikasi", subject: "Aplikasi error" });
    c = await buat(tLain, { category: "akun", subject: "Akun terkunci" });
    d = await buat(tLain, { category: "lainnya", subject: "Saldo 100%" });
    await atur(a, "open", "2026-01-04 00:00:00");
    await atur(b, "answered", "2026-01-03 00:00:00");
    await atur(c, "open", "2026-01-01 00:00:00");
    await atur(d, "closed", "2026-01-02 00:00:00");
  });

  test("tanpa status: semua, terbaru dulu; bentuk AdminTicketSummary; counts per status", async () => {
    const r = await get("/admin/tickets", tSuper).expect(200);
    expect(kode(r)).toEqual([a, b, d, c]);
    expect(r.body.meta).toEqual({ page: 1, limit: 20, total: 4, counts: { open: 2, answered: 1, closed: 1 } });
    for (const t of r.body.data) expect(Object.keys(t).sort()).toEqual(KUNCI_RINGKAS);
    expect(r.body.data[0]).toEqual({
      code: a, category: "pembayaran", subject: "VA belum lunas", status: "open", order_code: kodeBudi,
      created_at: expect.stringMatching(ISO), last_message_at: "2026-01-04T00:00:00.000Z",
      last_message_preview: ISI.message, last_sender_role: "customer",
      customer: { id: budi, full_name: "Budi", phone: "081234567890" },
    });
    expect(r.body.data[3].customer).toEqual({ id: lainId, full_name: "Pembeli 1", phone: "081300000001" });
    expect(JSON.stringify(r.body)).not.toContain("@mail.com");
  });

  test("status=open: terlama dulu; answered/closed: terbaru dulu; counts tetap seluruh tiket; status tak dikenal 400", async () => {
    const open = await get("/admin/tickets?status=open", tSuper).expect(200);
    expect(kode(open)).toEqual([c, a]);
    expect(open.body.meta).toEqual({ page: 1, limit: 20, total: 2, counts: { open: 2, answered: 1, closed: 1 } });
    expect(kode(await get("/admin/tickets?status=answered", tSuper).expect(200))).toEqual([b]);
    expect(kode(await get("/admin/tickets?status=closed", tSuper).expect(200))).toEqual([d]);
    await atur(b, "closed", "2026-01-05 00:00:00");
    expect(kode(await get("/admin/tickets?status=closed", tSuper).expect(200))).toEqual([b, d]);
    expect(kode(await get("/admin/tickets?status=", tSuper).expect(200))).toHaveLength(4);
    const e = await get("/admin/tickets?status=selesai", tSuper).expect(400);
    expect(e.body.error).toMatchObject({ code: "VALIDATION_ERROR", fields: { status: ["Status tidak dikenal."] } });
  });

  test("q: kode, judul (tanpa peka huruf), nama & nomor pembeli; % harfiah; bisa digabung status", async () => {
    const q = async (v: string, extra = "") => kode(await get(`/admin/tickets?q=${encodeURIComponent(v)}${extra}`, tSuper).expect(200));
    expect(await q(a)).toEqual([a]);
    expect(await q(c.slice(-5).toLowerCase())).toEqual([c]);
    expect(await q("aplikasi")).toEqual([b]);
    expect(await q("TERKUNCI")).toEqual([c]);
    expect(await q("pembeli 1")).toEqual([d, c]);
    expect(await q("081300000001")).toEqual([d, c]);
    expect(await q("0812345")).toEqual([a, b]);
    expect(await q("100%")).toEqual([d]);
    expect(await q("%")).toEqual([d]);
    expect(await q("tidak-ada")).toEqual([]);
    expect(await q("pembeli", "&status=open")).toEqual([c]);
    const r = await get("/admin/tickets?q=budi", tSuper).expect(200);
    expect(r.body.meta).toEqual({ page: 1, limit: 20, total: 2, counts: { open: 2, answered: 1, closed: 1 } });
  });

  test("halaman; limit ≤ 50", async () => {
    const r = await get("/admin/tickets?limit=1&page=2", tSuper).expect(200);
    expect(kode(r)).toEqual([b]);
    expect(r.body.meta).toMatchObject({ page: 2, limit: 1, total: 4 });
    expect((await get("/admin/tickets?limit=999", tSuper).expect(200)).body.meta.limit).toBe(50);
    expect((await get("/admin/tickets?page=x&limit=0", tSuper).expect(200)).body.meta).toMatchObject({ page: 1, limit: 20 });
  });
});

describe("GET /admin/tickets/:code", () => {
  test("AdminTicketDetail: pembeli lengkap, pesanan terkait, nama pengirim asli; tanpa pesanan → order null; 404", async () => {
    const a = await buat(s.tCust, { order_code: kodeBudi });
    await post(`/admin/tickets/${a}/messages`, tSuper, { body: "Sudah kami cek." }).expect(201);
    const r = await get(`/admin/tickets/${a}`, tSuper).expect(200);
    const dt = r.body.data;
    expect(Object.keys(dt).sort()).toEqual(KUNCI_DETAIL);
    const [[o]] = await db.query<any[]>("SELECT status, total, created_at FROM orders WHERE code = ?", [kodeBudi]);
    expect(dt).toMatchObject({
      code: a, category: "pembayaran", subject: ISI.subject, status: "answered", order_code: kodeBudi, last_sender_role: "admin",
      closed_at: null, closed_by: null,
      customer: { id: budi, full_name: "Budi", phone: "081234567890", email: "budi@mail.com" },
      order: { code: kodeBudi, status: o.status, total: o.total, merchant_name: "Dapur Siti", created_at: o.created_at.toISOString() },
    });
    expect(Object.keys(dt.order).sort()).toEqual(["code", "created_at", "merchant_name", "status", "total"]);
    expect(dt.messages).toEqual([
      { id: expect.any(Number), sender_role: "customer", sender_name: "Budi", body: ISI.message, created_at: expect.stringMatching(ISO) },
      { id: expect.any(Number), sender_role: "admin", sender_name: "Admin Super", body: "Sudah kami cek.", created_at: expect.stringMatching(ISO) },
    ]);
    // GET admin tidak menandai dibaca untuk pembeli
    expect((await baris(a)).customer_last_read_at).toBeNull();

    const b = await buat(tLain);
    expect((await get(`/admin/tickets/${b}`, tSuper).expect(200)).body.data).toMatchObject({ order: null, order_code: null });
    const e = await get("/admin/tickets/TK-20000101-ZZZZ", tSuper).expect(404);
    expect(e.body.error).toMatchObject({ code: "NOT_FOUND", message: "Tiket tidak ditemukan." });
  });
});

describe("POST /admin/tickets/:code/messages", () => {
  test("201: status answered, notifikasi info ke pembeli, audit; pembeli melihat Tim KateringKita & belum dibaca", async () => {
    const a = await buat(s.tCust, { subject: "VA belum lunas" });
    const r = await post(`/admin/tickets/${a}/messages`, tSuper, { body: "  Dana sudah masuk, status kami perbarui.  " }).expect(201);
    const dt = r.body.data;
    expect(Object.keys(dt).sort()).toEqual(KUNCI_DETAIL);
    expect(dt).toMatchObject({ code: a, status: "answered", last_sender_role: "admin" });
    expect(dt.messages[1]).toMatchObject({ sender_role: "admin", sender_name: "Admin Super", body: "Dana sudah masuk, status kami perbarui." });
    expect(dt.last_message_at).toBe(dt.messages[1].created_at);

    expect(await notifs(budi)).toEqual([
      { type: "info", title: `Balasan tiket ${a}`, body: 'Tim KateringKita membalas "VA belum lunas".', data: { ticket_code: a } },
    ]);
    expect(await notifs(lainId)).toEqual([]);
    const n = await get("/me/notifications?type=info", s.tCust).expect(200);
    expect(n.body.data[0]).toMatchObject({ type: "info", title: `Balasan tiket ${a}`, data: { ticket_code: a } });
    expect(await audit()).toEqual([{
      admin_user_id: superId, action: "ticket.reply", target_type: "ticket", target_id: a,
      before_json: { status: "open" }, after_json: { status: "answered", message_id: dt.messages[1].id },
    }]);

    const l = await get("/me/tickets", s.tCust).expect(200);
    expect(l.body.meta.unread_count).toBe(1);
    expect(l.body.data[0]).toMatchObject({ status: "answered", last_sender_role: "admin", unread: true });
    const c = await get(`/me/tickets/${a}`, s.tCust).expect(200);
    expect(c.body.data.messages[1]).toMatchObject({ sender_role: "admin", sender_name: "Tim KateringKita" });
    expect(JSON.stringify(c.body)).not.toContain("Admin Super");

    // pembeli membalas → open lagi; admin membalas lagi → answered
    await post(`/me/tickets/${a}/messages`, s.tCust, { body: "Terima kasih." }).expect(201);
    expect((await baris(a)).status).toBe("open");
    await post(`/admin/tickets/${a}/messages`, tSuper, { body: "Sama-sama." }).expect(201);
    expect((await baris(a)).status).toBe("answered");
    expect(await notifs(budi)).toHaveLength(2);
  });

  test("judul panjang: isi notifikasi ≤ 255; validasi 1–2000; tiket tidak ada 404; tertutup 409 tanpa notifikasi", async () => {
    const subject = "J".repeat(120);
    const a = await buat(s.tCust, { subject });
    await post(`/admin/tickets/${a}/messages`, tSuper, { body: "x" }).expect(201);
    const [nb] = await notifs(budi);
    expect(nb.body).toBe(`Tim KateringKita membalas "${subject}".`);
    expect(nb.body.length).toBeLessThanOrEqual(255);

    for (const body of [{}, { body: "  " }, { body: "x".repeat(2001) }]) {
      const e = await post(`/admin/tickets/${a}/messages`, tSuper, body).expect(400);
      expect(e.body.error).toMatchObject({ code: "VALIDATION_ERROR", fields: { body: ["Pesan 1–2000 karakter."] } });
    }
    await post(`/admin/tickets/${a}/messages`, tSuper, { body: "z".repeat(2000) }).expect(201);
    const e = await post("/admin/tickets/TK-20000101-ZZZZ/messages", tSuper, { body: "Halo" }).expect(404);
    expect(e.body.error).toMatchObject({ code: "NOT_FOUND", message: "Tiket tidak ditemukan." });

    await post(`/me/tickets/${a}/close`, s.tCust).expect(200);
    const tutup = await post(`/admin/tickets/${a}/messages`, tSuper, { body: "Halo" }).expect(409);
    expect(tutup.body.error).toEqual(DITUTUP);
    expect(await notifs(budi)).toHaveLength(2);
    expect((await audit()).map((x) => x.action)).toEqual(["ticket.reply", "ticket.reply"]);
  });
});

describe("POST /admin/tickets/:code/close", () => {
  test("200 closed oleh admin, notifikasi & audit; ulang tanpa perubahan/notifikasi; balas sesudahnya 409", async () => {
    const a = await buat(s.tCust, { subject: "VA belum lunas" });
    await post(`/admin/tickets/${a}/messages`, tSuper, { body: "Sudah beres ya." }).expect(201);
    const r = await post(`/admin/tickets/${a}/close`, tSuper).expect(200);
    expect(Object.keys(r.body.data).sort()).toEqual(KUNCI_DETAIL);
    expect(r.body.data).toMatchObject({ code: a, status: "closed", closed_by: "admin" });
    expect(r.body.data.closed_at).toMatch(ISO);
    expect((await notifs(budi))[1]).toEqual({
      type: "info", title: `Tiket ${a} ditutup`, body: 'Tiket "VA belum lunas" ditutup oleh Tim KateringKita.', data: { ticket_code: a },
    });
    expect((await audit())[1]).toEqual({
      admin_user_id: superId, action: "ticket.close", target_type: "ticket", target_id: a,
      before_json: { status: "answered" }, after_json: { status: "closed" },
    });

    await db.query("UPDATE support_tickets SET closed_at = '2026-01-01 00:00:00' WHERE code = ?", [a]);
    const ulang = await post(`/admin/tickets/${a}/close`, tSuper).expect(200);
    expect(ulang.body.data).toMatchObject({ status: "closed", closed_by: "admin", closed_at: "2026-01-01T00:00:00.000Z" });
    expect(await notifs(budi)).toHaveLength(2);
    expect(await audit()).toHaveLength(2);

    expect((await post(`/admin/tickets/${a}/messages`, tSuper, { body: "Halo" }).expect(409)).body.error).toEqual(DITUTUP);
    expect((await post(`/me/tickets/${a}/messages`, s.tCust, { body: "Halo" }).expect(409)).body.error).toEqual(DITUTUP);
  });

  test("tiket yang ditutup pembeli: 200 tanpa perubahan/notifikasi; tidak ada 404", async () => {
    const a = await buat(s.tCust);
    await post(`/me/tickets/${a}/close`, s.tCust).expect(200);
    const r = await post(`/admin/tickets/${a}/close`, tSuper).expect(200);
    expect(r.body.data).toMatchObject({ status: "closed", closed_by: "customer" });
    expect(await notifs(budi)).toEqual([]);
    expect(await audit()).toEqual([]);
    const e = await post("/admin/tickets/TK-20000101-ZZZZ/close", tSuper).expect(404);
    expect(e.body.error).toMatchObject({ code: "NOT_FOUND", message: "Tiket tidak ditemukan." });
  });
});

describe("akses /admin/tickets", () => {
  test("support & ops boleh baca, balas, tutup; support tetap tidak boleh menulis di luar /tickets", async () => {
    for (const [tok, nama] of [[tSupport, "Admin Support"], [tOps, "Admin Ops"]]) {
      const a = await buat(s.tCust);
      expect(kode(await get("/admin/tickets", tok).expect(200))).toContain(a);
      await get(`/admin/tickets/${a}`, tok).expect(200);
      const r = await post(`/admin/tickets/${a}/messages`, tok, { body: "Kami bantu cek." }).expect(201);
      expect(r.body.data.messages[1].sender_name).toBe(nama);
      await post(`/admin/tickets/${a}/close`, tok).expect(200);
    }
    expect((await audit()).filter((x) => x.admin_user_id === supportId).map((x) => x.action)).toEqual(["ticket.reply", "ticket.close"]);

    await get("/admin/merchants", tSupport).expect(200);
    const larang = await post("/admin/broadcasts", tSupport, { audience: "all", title: "x", body: "y" }).expect(403);
    expect(larang.body.error.code).toBe("FORBIDDEN");
    await post("/admin/reviews/1/hide", tSupport, { reason: "x" }).expect(403);
    await request(app).put("/api/v1/admin/settings/cs-contact").set(H(tSupport)).send({ wa_number: "" }).expect(403);
  });

  test("pembeli & penjual 403, tanpa token 401", async () => {
    const a = await buat(s.tCust);
    for (const tok of [s.tCust, s.tA]) {
      await get("/admin/tickets", tok).expect(403);
      await get(`/admin/tickets/${a}`, tok).expect(403);
      await post(`/admin/tickets/${a}/messages`, tok, { body: "Halo" }).expect(403);
      await post(`/admin/tickets/${a}/close`, tok).expect(403);
    }
    await request(app).get("/api/v1/admin/tickets").expect(401);
    expect(await baris(a)).toMatchObject({ status: "open", closed_at: null });
    expect(await notifs(budi)).toEqual([]);
  });
});
