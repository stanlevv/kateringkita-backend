import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { createAdmin } from "../src/scripts/create-admin";
import { chatLimiter } from "../src/middleware/rate-limiter";
import { login, placeOrder, prepareCheckout } from "./helpers/merchant";

// Laporan chat (/orders/:code/chat-report, /merchant/orders/:code/chat-report) dan baca admin (/admin/chat-reports).
let setup: Awaited<ReturnType<typeof prepareCheckout>>;
let superToken: string;
let supportToken: string;

const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });
const get = (urlPath: string, token: string) => request(app).get(`/api/v1${urlPath}`).set(authHeader(token));
const post = (urlPath: string, token: string, body?: object) => {
  const req = request(app).post(`/api/v1${urlPath}`).set(authHeader(token));
  return body === undefined ? req : req.send(body);
};
const confirmedOrder = async () => {
  const code = await placeOrder(setup.customerToken, setup.menu);
  await post(`/merchant/orders/${code}/confirm`, setup.tokenA).expect(200);
  return code;
};
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const REPORT_KEYS = ["created_at", "id", "order_code", "reason", "reporter_name", "reporter_role"];

beforeAll(async () => {
  setup = await prepareCheckout();
  await createAdmin({ phone: "081300000009", fullName: "Admin Super", password: "rahasia123" });
  await createAdmin({ phone: "081300000011", fullName: "Admin Support", password: "rahasia123" });
  await db.query("UPDATE users SET admin_level = 'support' WHERE phone = '081300000011'");
  [superToken, supportToken] = [await login("081300000009"), await login("081300000011")];
});
beforeEach(async () => {
  chatLimiter.reset();
  await db.query("UPDATE orders SET status = 'expired' WHERE status = 'holding'");
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("POST …/chat-report", () => {
  test("alasan 4 karakter 400; sah 201; kedua dari pihak sama 409; pihak lawan tetap boleh", async () => {
    const code = await confirmedOrder();
    const short = await post(`/orders/${code}/chat-report`, setup.customerToken, { reason: "abcd" }).expect(400);
    expect(short.body.error.code).toBe("VALIDATION_ERROR");
    await post(`/orders/${code}/chat-report`, setup.customerToken, { reason: "a".repeat(501) }).expect(400);
    await post(`/orders/${code}/chat-report`, setup.customerToken, {}).expect(400);

    const created = await post(`/orders/${code}/chat-report`, setup.customerToken, { reason: "  Penjual kasar  " });
    expect(created.status).toBe(201);
    expect(Object.keys(created.body.data).sort()).toEqual(["created_at", "id", "reason", "reporter_role"]);
    expect(created.body.data).toMatchObject({ reporter_role: "customer", reason: "Penjual kasar" });
    expect(created.body.data.created_at).toMatch(ISO);

    const again = await post(`/orders/${code}/chat-report`, setup.customerToken, { reason: "Masih kasar" }).expect(409);
    expect(again.body.error).toMatchObject({ code: "ALREADY_REPORTED", message: "Chat ini sudah kamu laporkan." });
    await post(`/merchant/orders/${code}/chat-report`, setup.tokenA, { reason: "Pembeli mengancam" }).expect(201);
    const merchantAgain = await post(`/merchant/orders/${code}/chat-report`, setup.tokenA, { reason: "Lagi lagi" });
    expect(merchantAgain.status).toBe(409);
  });

  test("chat.reported_by_me menjadi true setelah melapor, hanya untuk pelapor", async () => {
    const code = await confirmedOrder();
    expect((await get(`/orders/${code}`, setup.customerToken).expect(200)).body.data.chat.reported_by_me).toBe(false);
    await post(`/orders/${code}/chat-report`, setup.customerToken, { reason: "Penjual kasar" }).expect(201);
    expect((await get(`/orders/${code}`, setup.customerToken).expect(200)).body.data.chat.reported_by_me).toBe(true);
    const messages = await get(`/orders/${code}/messages`, setup.customerToken).expect(200);
    expect(messages.body.data.chat.reported_by_me).toBe(true);
    const merchantView = await get(`/merchant/orders/${code}/messages`, setup.tokenA).expect(200);
    expect(merchantView.body.data.chat.reported_by_me).toBe(false);
  });

  test("laporan tetap boleh setelah pesanan selesai", async () => {
    const code = await confirmedOrder();
    for (const action of ["cook", "ready", "complete"])
      await post(`/merchant/orders/${code}/${action}`, setup.tokenA).expect(200);
    await post(`/orders/${code}/chat-report`, setup.customerToken, { reason: "Ada ancaman di chat" }).expect(201);
  });
});

describe("GET /admin/chat-reports", () => {
  test("admin (semua tingkat) membaca daftar dan seluruh pesan chat yang dilaporkan", async () => {
    await db.query("DELETE FROM order_chat_reports");
    const reported = await confirmedOrder();
    const unreported = await confirmedOrder();
    await post(`/orders/${reported}/messages`, setup.customerToken, { body: "Halo kak" }).expect(201);
    await post(`/merchant/orders/${reported}/messages`, setup.tokenA, { body: "Pesanan sudah siap" }).expect(201);
    await post(`/orders/${unreported}/messages`, setup.customerToken, { body: "Rahasia" }).expect(201);
    await post(`/orders/${reported}/chat-report`, setup.customerToken, { reason: "Penjual kasar" }).expect(201);
    await post(`/merchant/orders/${reported}/chat-report`, setup.tokenA, { reason: "Pembeli mengancam" }).expect(201);

    for (const token of [superToken, supportToken]) {
      const list = await get("/admin/chat-reports", token).expect(200);
      expect(list.body.meta).toEqual({ page: 1, limit: 20, total: 2 });
      for (const report of list.body.data) expect(Object.keys(report).sort()).toEqual(REPORT_KEYS);
      // Terbaru dulu: laporan penjual dibuat terakhir.
      expect(list.body.data.map((report: any) => report.reporter_role)).toEqual(["merchant", "customer"]);
      expect(list.body.data[1]).toMatchObject({ order_code: reported, reporter_name: "Budi", reason: "Penjual kasar" });
      expect(list.body.data[0].reporter_name).toBe("Siti");
    }
    const page = await get("/admin/chat-reports?page=2&limit=1", superToken).expect(200);
    expect(page.body.data.map((report: any) => report.reporter_role)).toEqual(["customer"]);

    const reportId = (await get("/admin/chat-reports", supportToken)).body.data[1].id;
    const detail = await get(`/admin/chat-reports/${reportId}`, supportToken).expect(200);
    expect(Object.keys(detail.body.data).sort()).toEqual([...REPORT_KEYS, "messages"].sort());
    expect(detail.body.data.messages.map((message: any) => [message.sender_role, message.body])).toEqual([
      ["customer", "Halo kak"],
      ["merchant", "Pesanan sudah siap"],
    ]);
    expect(JSON.stringify(detail.body)).not.toContain("Rahasia");
  });

  test("tidak ada jalur admin ke chat yang tidak dilaporkan: id tidak ada / bukan angka 404", async () => {
    await get("/admin/chat-reports/999999", superToken).expect(404);
    await get("/admin/chat-reports/abc", superToken).expect(404);
    // Number() membaca "1e1" sebagai 10 dan "0x.." sebagai heksadesimal; keduanya harus tetap 404.
    const reportId = Number((await get("/admin/chat-reports", superToken)).body.data[0].id);
    await get(`/admin/chat-reports/${reportId}`, superToken).expect(200);
    await get("/admin/chat-reports/1e1", superToken).expect(404);
    await get(`/admin/chat-reports/${reportId}e0`, superToken).expect(404);
    await get(`/admin/chat-reports/0x${reportId.toString(16)}`, superToken).expect(404);
    const unreported = await confirmedOrder();
    await get(`/admin/orders/${unreported}/messages`, superToken).expect(404);
    await get(`/admin/chat-reports/${unreported}`, superToken).expect(404);
  });

  test("pembeli dan penjual 403, tanpa token 401", async () => {
    await get("/admin/chat-reports", setup.customerToken).expect(403);
    await get("/admin/chat-reports", setup.tokenA).expect(403);
    await request(app).get("/api/v1/admin/chat-reports").expect(401);
  });
});
