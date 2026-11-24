import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { createAdmin } from "../src/scripts/create-admin";
import { ticketLimiter } from "../src/middleware/rate-limiter";
import { login, createCustomer, placeOrder, prepareCheckout } from "./helpers/merchant";

// Tiket bantuan (CS) sisi admin: /admin/tickets (kontrak tiket-kontrak.md); semua tingkat admin boleh baca & balas
let setup: Awaited<ReturnType<typeof prepareCheckout>>;
let otherToken: string;
let superToken: string;
let opsToken: string;
let supportToken: string;
let superId: number;
let supportId: number;
let budi: number;
let otherCustomerId: number;
let budiCode: string;

const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });
const get = (path: string, token: string) => request(app).get(`/api/v1${path}`).set(authHeader(token));
const post = (path: string, token: string, body?: object) => {
  const req = request(app).post(`/api/v1${path}`).set(authHeader(token));
  return body === undefined ? req : req.send(body);
};
const TICKET_INPUT = {
  category: "pembayaran",
  subject: "VA sudah dibayar",
  message: "Status belum lunas padahal sudah bayar.",
};
const createTicket = async (token: string, overrides: object = {}) =>
  (await post("/me/tickets", token, { ...TICKET_INPUT, ...overrides }).expect(201)).body.data.code as string;
const ticketCodes = (res: request.Response) => res.body.data.map((ticket: any) => ticket.code);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SUMMARY_KEYS = [
  "category",
  "code",
  "created_at",
  "customer",
  "last_message_at",
  "last_message_preview",
  "last_sender_role",
  "order_code",
  "status",
  "subject",
];
const DETAIL_KEYS = [
  "category",
  "closed_at",
  "closed_by",
  "code",
  "created_at",
  "customer",
  "last_message_at",
  "last_sender_role",
  "messages",
  "order",
  "order_code",
  "status",
  "subject",
];
const CLOSED_ERROR = {
  code: "TICKET_CLOSED",
  message: "Tiket sudah ditutup. Buat tiket baru bila masih perlu bantuan.",
};

const ticketRow = async (code: string) =>
  ((await db.query<any[]>("SELECT * FROM support_tickets WHERE code = ?", [code]))[0] as any[])[0];
const getNotifications = async (userId: number) =>
  (
    await db.query<any[]>("SELECT type, title, body, data FROM notifications WHERE user_id = ? ORDER BY id", [userId])
  )[0] as any[];
const audit = async () =>
  (
    await db.query<any[]>(
      "SELECT admin_user_id, action, target_type, target_id, before_json, after_json FROM admin_audit_logs ORDER BY id",
    )
  )[0] as any[];
const setTicketStatus = (code: string, status: string, timestamp: string) =>
  db.query("UPDATE support_tickets SET status = ?, last_message_at = ? WHERE code = ?", [status, timestamp, code]);

beforeAll(async () => {
  setup = await prepareCheckout();
  otherToken = await createCustomer(1);
  superId = (await createAdmin({ phone: "081300000009", fullName: "Admin Super", password: "rahasia123" })).id;
  await createAdmin({ phone: "081300000010", fullName: "Admin Ops", password: "rahasia123" });
  supportId = (await createAdmin({ phone: "081300000011", fullName: "Admin Support", password: "rahasia123" })).id;
  await db.query("UPDATE users SET admin_level = 'ops' WHERE phone = '081300000010'");
  await db.query("UPDATE users SET admin_level = 'support' WHERE phone = '081300000011'");
  [superToken, opsToken, supportToken] = [
    await login("081300000009"),
    await login("081300000010"),
    await login("081300000011"),
  ];
  const [users] = await db.query<any[]>(
    "SELECT id, email FROM users WHERE email IN ('budi@mail.com', 'pembeli1@mail.com')",
  );
  budi = users.find((user: any) => user.email === "budi@mail.com").id;
  otherCustomerId = users.find((user: any) => user.email === "pembeli1@mail.com").id;
  budiCode = await placeOrder(setup.customerToken, setup.menu);
});
beforeEach(async () => {
  await db.query("DELETE FROM support_tickets");
  await db.query("DELETE FROM notifications");
  await db.query("DELETE FROM admin_audit_logs");
  ticketLimiter.reset();
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("GET /admin/tickets", () => {
  let vaTicket: string, appTicket: string, accountTicket: string, balanceTicket: string;
  beforeEach(async () => {
    vaTicket = await createTicket(setup.customerToken, { subject: "VA belum lunas", order_code: budiCode });
    appTicket = await createTicket(setup.customerToken, { category: "aplikasi", subject: "Aplikasi error" });
    accountTicket = await createTicket(otherToken, { category: "akun", subject: "Akun terkunci" });
    balanceTicket = await createTicket(otherToken, { category: "lainnya", subject: "Saldo 100%" });
    await setTicketStatus(vaTicket, "open", "2026-01-04 00:00:00");
    await setTicketStatus(appTicket, "answered", "2026-01-03 00:00:00");
    await setTicketStatus(accountTicket, "open", "2026-01-01 00:00:00");
    await setTicketStatus(balanceTicket, "closed", "2026-01-02 00:00:00");
  });

  test("tanpa status: semua, terbaru dulu; bentuk AdminTicketSummary; counts per status", async () => {
    const res = await get("/admin/tickets", superToken).expect(200);
    expect(ticketCodes(res)).toEqual([vaTicket, appTicket, balanceTicket, accountTicket]);
    expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 4, counts: { open: 2, answered: 1, closed: 1 } });
    for (const ticket of res.body.data) expect(Object.keys(ticket).sort()).toEqual(SUMMARY_KEYS);
    expect(res.body.data[0]).toEqual({
      code: vaTicket,
      category: "pembayaran",
      subject: "VA belum lunas",
      status: "open",
      order_code: budiCode,
      created_at: expect.stringMatching(ISO),
      last_message_at: "2026-01-04T00:00:00.000Z",
      last_message_preview: TICKET_INPUT.message,
      last_sender_role: "customer",
      customer: { id: budi, full_name: "Budi", phone: "081234567890" },
    });
    expect(res.body.data[3].customer).toEqual({ id: otherCustomerId, full_name: "Pembeli 1", phone: "081300000001" });
    expect(JSON.stringify(res.body)).not.toContain("@mail.com");
  });

  test("status=open: terlama dulu; answered/closed: terbaru dulu; counts tetap seluruh tiket; status tak dikenal 400", async () => {
    const open = await get("/admin/tickets?status=open", superToken).expect(200);
    expect(ticketCodes(open)).toEqual([accountTicket, vaTicket]);
    expect(open.body.meta).toEqual({ page: 1, limit: 20, total: 2, counts: { open: 2, answered: 1, closed: 1 } });
    expect(ticketCodes(await get("/admin/tickets?status=answered", superToken).expect(200))).toEqual([appTicket]);
    expect(ticketCodes(await get("/admin/tickets?status=closed", superToken).expect(200))).toEqual([balanceTicket]);
    await setTicketStatus(appTicket, "closed", "2026-01-05 00:00:00");
    expect(ticketCodes(await get("/admin/tickets?status=closed", superToken).expect(200))).toEqual([
      appTicket,
      balanceTicket,
    ]);
    expect(ticketCodes(await get("/admin/tickets?status=", superToken).expect(200))).toHaveLength(4);
    const errorRes = await get("/admin/tickets?status=selesai", superToken).expect(400);
    expect(errorRes.body.error).toMatchObject({
      code: "VALIDATION_ERROR",
      fields: { status: ["Status tidak dikenal."] },
    });
  });

  test("q: kode, judul (tanpa peka huruf), nama & nomor pembeli; % harfiah; bisa digabung status", async () => {
    const search = async (text: string, extra = "") =>
      ticketCodes(await get(`/admin/tickets?q=${encodeURIComponent(text)}${extra}`, superToken).expect(200));
    expect(await search(vaTicket)).toEqual([vaTicket]);
    expect(await search(accountTicket.slice(-5).toLowerCase())).toEqual([accountTicket]);
    expect(await search("aplikasi")).toEqual([appTicket]);
    expect(await search("TERKUNCI")).toEqual([accountTicket]);
    expect(await search("pembeli 1")).toEqual([balanceTicket, accountTicket]);
    expect(await search("081300000001")).toEqual([balanceTicket, accountTicket]);
    expect(await search("0812345")).toEqual([vaTicket, appTicket]);
    expect(await search("100%")).toEqual([balanceTicket]);
    expect(await search("%")).toEqual([balanceTicket]);
    expect(await search("tidak-ada")).toEqual([]);
    expect(await search("pembeli", "&status=open")).toEqual([accountTicket]);
    const res = await get("/admin/tickets?q=budi", superToken).expect(200);
    expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 2, counts: { open: 2, answered: 1, closed: 1 } });
  });

  test("halaman; limit ≤ 50", async () => {
    const res = await get("/admin/tickets?limit=1&page=2", superToken).expect(200);
    expect(ticketCodes(res)).toEqual([appTicket]);
    expect(res.body.meta).toMatchObject({ page: 2, limit: 1, total: 4 });
    expect((await get("/admin/tickets?limit=999", superToken).expect(200)).body.meta.limit).toBe(50);
    expect((await get("/admin/tickets?page=x&limit=0", superToken).expect(200)).body.meta).toMatchObject({
      page: 1,
      limit: 20,
    });
  });
});

describe("GET /admin/tickets/:code", () => {
  test("AdminTicketDetail: pembeli lengkap, pesanan terkait, nama pengirim asli; tanpa pesanan → order null; 404", async () => {
    const code = await createTicket(setup.customerToken, { order_code: budiCode });
    await post(`/admin/tickets/${code}/messages`, superToken, { body: "Sudah kami cek." }).expect(201);
    const res = await get(`/admin/tickets/${code}`, superToken).expect(200);
    const detail = res.body.data;
    expect(Object.keys(detail).sort()).toEqual(DETAIL_KEYS);
    const [[order]] = await db.query<any[]>("SELECT status, total, created_at FROM orders WHERE code = ?", [budiCode]);
    expect(detail).toMatchObject({
      code,
      category: "pembayaran",
      subject: TICKET_INPUT.subject,
      status: "answered",
      order_code: budiCode,
      last_sender_role: "admin",
      closed_at: null,
      closed_by: null,
      customer: { id: budi, full_name: "Budi", phone: "081234567890", email: "budi@mail.com" },
      order: {
        code: budiCode,
        status: order.status,
        total: order.total,
        merchant_name: "Dapur Siti",
        created_at: order.created_at.toISOString(),
      },
    });
    expect(Object.keys(detail.order).sort()).toEqual(["code", "created_at", "merchant_name", "status", "total"]);
    expect(detail.messages).toEqual([
      {
        id: expect.any(Number),
        sender_role: "customer",
        sender_name: "Budi",
        body: TICKET_INPUT.message,
        created_at: expect.stringMatching(ISO),
      },
      {
        id: expect.any(Number),
        sender_role: "admin",
        sender_name: "Admin Super",
        body: "Sudah kami cek.",
        created_at: expect.stringMatching(ISO),
      },
    ]);
    // GET admin tidak menandai dibaca untuk pembeli
    expect((await ticketRow(code)).customer_last_read_at).toBeNull();

    const otherCode = await createTicket(otherToken);
    expect((await get(`/admin/tickets/${otherCode}`, superToken).expect(200)).body.data).toMatchObject({
      order: null,
      order_code: null,
    });
    const errorRes = await get("/admin/tickets/TK-20000101-ZZZZ", superToken).expect(404);
    expect(errorRes.body.error).toMatchObject({ code: "NOT_FOUND", message: "Tiket tidak ditemukan." });
  });
});

describe("POST /admin/tickets/:code/messages", () => {
  test("201: status answered, notifikasi info ke pembeli, audit; pembeli melihat Tim KateringKita & belum dibaca", async () => {
    const code = await createTicket(setup.customerToken, { subject: "VA belum lunas" });
    const res = await post(`/admin/tickets/${code}/messages`, superToken, {
      body: "  Dana sudah masuk, status kami perbarui.  ",
    }).expect(201);
    const detail = res.body.data;
    expect(Object.keys(detail).sort()).toEqual(DETAIL_KEYS);
    expect(detail).toMatchObject({ code, status: "answered", last_sender_role: "admin" });
    expect(detail.messages[1]).toMatchObject({
      sender_role: "admin",
      sender_name: "Admin Super",
      body: "Dana sudah masuk, status kami perbarui.",
    });
    expect(detail.last_message_at).toBe(detail.messages[1].created_at);

    expect(await getNotifications(budi)).toEqual([
      {
        type: "info",
        title: `Balasan tiket ${code}`,
        body: 'Tim KateringKita membalas "VA belum lunas".',
        data: { ticket_code: code },
      },
    ]);
    expect(await getNotifications(otherCustomerId)).toEqual([]);
    const notifications = await get("/me/notifications?type=info", setup.customerToken).expect(200);
    expect(notifications.body.data[0]).toMatchObject({
      type: "info",
      title: `Balasan tiket ${code}`,
      data: { ticket_code: code },
    });
    expect(await audit()).toEqual([
      {
        admin_user_id: superId,
        action: "ticket.reply",
        target_type: "ticket",
        target_id: code,
        before_json: { status: "open" },
        after_json: { status: "answered", message_id: detail.messages[1].id },
      },
    ]);

    const list = await get("/me/tickets", setup.customerToken).expect(200);
    expect(list.body.meta.unread_count).toBe(1);
    expect(list.body.data[0]).toMatchObject({ status: "answered", last_sender_role: "admin", unread: true });
    const customerView = await get(`/me/tickets/${code}`, setup.customerToken).expect(200);
    expect(customerView.body.data.messages[1]).toMatchObject({ sender_role: "admin", sender_name: "Tim KateringKita" });
    expect(JSON.stringify(customerView.body)).not.toContain("Admin Super");

    // pembeli membalas → open lagi; admin membalas lagi → answered
    await post(`/me/tickets/${code}/messages`, setup.customerToken, { body: "Terima kasih." }).expect(201);
    expect((await ticketRow(code)).status).toBe("open");
    await post(`/admin/tickets/${code}/messages`, superToken, { body: "Sama-sama." }).expect(201);
    expect((await ticketRow(code)).status).toBe("answered");
    expect(await getNotifications(budi)).toHaveLength(2);
  });

  test("judul panjang: isi notifikasi ≤ 255; validasi 1–2000; tiket tidak ada 404; tertutup 409 tanpa notifikasi", async () => {
    const subject = "J".repeat(120);
    const code = await createTicket(setup.customerToken, { subject });
    await post(`/admin/tickets/${code}/messages`, superToken, { body: "x" }).expect(201);
    const [notification] = await getNotifications(budi);
    expect(notification.body).toBe(`Tim KateringKita membalas "${subject}".`);
    expect(notification.body.length).toBeLessThanOrEqual(255);

    for (const body of [{}, { body: "  " }, { body: "x".repeat(2001) }]) {
      const errorRes = await post(`/admin/tickets/${code}/messages`, superToken, body).expect(400);
      expect(errorRes.body.error).toMatchObject({
        code: "VALIDATION_ERROR",
        fields: { body: ["Pesan 1–2000 karakter."] },
      });
    }
    await post(`/admin/tickets/${code}/messages`, superToken, { body: "z".repeat(2000) }).expect(201);
    const notFoundRes = await post("/admin/tickets/TK-20000101-ZZZZ/messages", superToken, { body: "Halo" }).expect(
      404,
    );
    expect(notFoundRes.body.error).toMatchObject({ code: "NOT_FOUND", message: "Tiket tidak ditemukan." });

    await post(`/me/tickets/${code}/close`, setup.customerToken).expect(200);
    const closedRes = await post(`/admin/tickets/${code}/messages`, superToken, { body: "Halo" }).expect(409);
    expect(closedRes.body.error).toEqual(CLOSED_ERROR);
    expect(await getNotifications(budi)).toHaveLength(2);
    expect((await audit()).map((entry) => entry.action)).toEqual(["ticket.reply", "ticket.reply"]);
  });
});

describe("POST /admin/tickets/:code/close", () => {
  test("200 closed oleh admin, notifikasi & audit; ulang tanpa perubahan/notifikasi; balas sesudahnya 409", async () => {
    const code = await createTicket(setup.customerToken, { subject: "VA belum lunas" });
    await post(`/admin/tickets/${code}/messages`, superToken, { body: "Sudah beres ya." }).expect(201);
    const res = await post(`/admin/tickets/${code}/close`, superToken).expect(200);
    expect(Object.keys(res.body.data).sort()).toEqual(DETAIL_KEYS);
    expect(res.body.data).toMatchObject({ code, status: "closed", closed_by: "admin" });
    expect(res.body.data.closed_at).toMatch(ISO);
    expect((await getNotifications(budi))[1]).toEqual({
      type: "info",
      title: `Tiket ${code} ditutup`,
      body: 'Tiket "VA belum lunas" ditutup oleh Tim KateringKita.',
      data: { ticket_code: code },
    });
    expect((await audit())[1]).toEqual({
      admin_user_id: superId,
      action: "ticket.close",
      target_type: "ticket",
      target_id: code,
      before_json: { status: "answered" },
      after_json: { status: "closed" },
    });

    await db.query("UPDATE support_tickets SET closed_at = '2026-01-01 00:00:00' WHERE code = ?", [code]);
    const closeAgain = await post(`/admin/tickets/${code}/close`, superToken).expect(200);
    expect(closeAgain.body.data).toMatchObject({
      status: "closed",
      closed_by: "admin",
      closed_at: "2026-01-01T00:00:00.000Z",
    });
    expect(await getNotifications(budi)).toHaveLength(2);
    expect(await audit()).toHaveLength(2);

    expect(
      (await post(`/admin/tickets/${code}/messages`, superToken, { body: "Halo" }).expect(409)).body.error,
    ).toEqual(CLOSED_ERROR);
    expect(
      (await post(`/me/tickets/${code}/messages`, setup.customerToken, { body: "Halo" }).expect(409)).body.error,
    ).toEqual(CLOSED_ERROR);
  });

  test("tiket yang ditutup pembeli: 200 tanpa perubahan/notifikasi; tidak ada 404", async () => {
    const code = await createTicket(setup.customerToken);
    await post(`/me/tickets/${code}/close`, setup.customerToken).expect(200);
    const res = await post(`/admin/tickets/${code}/close`, superToken).expect(200);
    expect(res.body.data).toMatchObject({ status: "closed", closed_by: "customer" });
    expect(await getNotifications(budi)).toEqual([]);
    expect(await audit()).toEqual([]);
    const errorRes = await post("/admin/tickets/TK-20000101-ZZZZ/close", superToken).expect(404);
    expect(errorRes.body.error).toMatchObject({ code: "NOT_FOUND", message: "Tiket tidak ditemukan." });
  });
});

describe("akses /admin/tickets", () => {
  test("support & ops boleh baca, balas, tutup; support tetap tidak boleh menulis di luar /tickets", async () => {
    for (const [token, adminName] of [
      [supportToken, "Admin Support"],
      [opsToken, "Admin Ops"],
    ]) {
      const code = await createTicket(setup.customerToken);
      expect(ticketCodes(await get("/admin/tickets", token).expect(200))).toContain(code);
      await get(`/admin/tickets/${code}`, token).expect(200);
      const res = await post(`/admin/tickets/${code}/messages`, token, { body: "Kami bantu cek." }).expect(201);
      expect(res.body.data.messages[1].sender_name).toBe(adminName);
      await post(`/admin/tickets/${code}/close`, token).expect(200);
    }
    expect((await audit()).filter((entry) => entry.admin_user_id === supportId).map((entry) => entry.action)).toEqual([
      "ticket.reply",
      "ticket.close",
    ]);

    await get("/admin/merchants", supportToken).expect(200);
    const forbiddenRes = await post("/admin/broadcasts", supportToken, {
      audience: "all",
      title: "x",
      body: "y",
    }).expect(403);
    expect(forbiddenRes.body.error.code).toBe("FORBIDDEN");
    await post("/admin/reviews/1/hide", supportToken, { reason: "x" }).expect(403);
    await request(app)
      .put("/api/v1/admin/settings/cs-contact")
      .set(authHeader(supportToken))
      .send({ wa_number: "" })
      .expect(403);
  });

  test("pembeli & penjual 403, tanpa token 401", async () => {
    const code = await createTicket(setup.customerToken);
    for (const token of [setup.customerToken, setup.tokenA]) {
      await get("/admin/tickets", token).expect(403);
      await get(`/admin/tickets/${code}`, token).expect(403);
      await post(`/admin/tickets/${code}/messages`, token, { body: "Halo" }).expect(403);
      await post(`/admin/tickets/${code}/close`, token).expect(403);
    }
    await request(app).get("/api/v1/admin/tickets").expect(401);
    expect(await ticketRow(code)).toMatchObject({ status: "open", closed_at: null });
    expect(await getNotifications(budi)).toEqual([]);
  });
});
