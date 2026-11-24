import { ResultSetHeader, RowDataPacket } from "mysql2";
import request from "supertest";
import { beforeAll, describe, expect, test } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { migrate } from "../src/scripts/migrate";
import { createAdmin } from "../src/scripts/create-admin";
import { loginLimiter } from "../src/middleware/rate-limiter";
import { resetTestDatabase } from "./helpers/db";
import { login } from "./helpers/merchant";

// Hitungan antrean dashboard admin (GET /admin/queues, F34): tiap angka harus sama dengan antrean di halaman tujuannya,
// dan dua kunci uang hanya untuk admin super.
let superToken: string;
let opsToken: string;
let supportToken: string;
let merchantToken: string;

const get = (urlPath: string, token: string) =>
  request(app).get(`/api/v1/admin${urlPath}`).set("Authorization", `Bearer ${token}`);

beforeAll(async () => {
  await migrate(await resetTestDatabase());
  loginLimiter.reset();
  for (const [phone, name] of [
    ["081300000009", "Admin Super"],
    ["081300000010", "Admin Ops"],
    ["081300000011", "Admin Support"],
  ])
    await createAdmin({ phone, fullName: name, password: "rahasia123" });
  await db.query("UPDATE users SET admin_level = 'ops' WHERE phone = '081300000010'");
  await db.query("UPDATE users SET admin_level = 'support' WHERE phone = '081300000011'");
  [superToken, opsToken, supportToken] = [
    await login("081300000009"),
    await login("081300000010"),
    await login("081300000011"),
  ];

  // Toko: A terverifikasi, B perlu perbaikan, C menunggu verifikasi.
  for (const [i, ownerName] of ["Siti", "Andi", "Budi"].entries())
    await request(app)
      .post("/api/v1/auth/merchant/register")
      .send({
        full_name: ownerName,
        email: `${ownerName}@mail.com`,
        phone: `08121111222${i}`,
        password: "rahasia123",
        business_name: `Dapur ${ownerName}`,
        merchant_type_id: 1,
        address: "Jl. Mawar 1",
      })
      .expect(201);
  const [merchants] = await db.query<RowDataPacket[]>("SELECT id FROM merchants ORDER BY id");
  const [merchantA, merchantB] = merchants.map((row) => row.id as number);
  await db.query("UPDATE merchants SET verification_status = 'verified' WHERE id = ?", [merchantA]);
  await db.query("UPDATE merchants SET verification_status = 'needs_fix' WHERE id = ?", [merchantB]);
  merchantToken = await login("081211112220");

  // Tiket: 2 open, 1 answered, 1 closed.
  const [customer] = await db.query<ResultSetHeader>(
    "INSERT INTO users (role, full_name, phone, password_hash) VALUES ('customer', 'Pembeli', '081355550000', 'x')",
  );
  for (const [i, status] of ["open", "open", "answered", "closed"].entries())
    await db.query(
      `INSERT INTO support_tickets (code, user_id, category, subject, status, last_message_at)
       VALUES (?, ?, 'lainnya', 'Tanya', ?, UTC_TIMESTAMP())`,
      [`TK-20261125-000${i}`, customer.insertId, status],
    );

  // Pesanan: A 2 selesai VA lunas + 1 COD, B 1 selesai VA lunas → 2 toko menunggu pencairan.
  // Satu pesanan batal yang sudah lunas → 1 refund.
  let seq = 0;
  const insertOrder = async (merchantId: number, status: string, method: string, paymentStatus: string) => {
    const [result] = await db.query<ResultSetHeader>(
      `INSERT INTO orders (code, customer_id, merchant_id, pickup_point_id, status, customer_name, customer_phone, subtotal,
         total, payment_method, payment_status, hold_until, completed_at)
       VALUES (?, ?, ?, 1, ?, 'P', '081355550000', 20000, 20000, ?, ?, UTC_TIMESTAMP(),
         IF(? = 'completed', UTC_TIMESTAMP() - INTERVAL 1 HOUR, NULL))`,
      [`KK-Q-000${++seq}`, customer.insertId, merchantId, status, method, paymentStatus, status],
    );
    return result.insertId;
  };
  await insertOrder(merchantA, "completed", "va", "paid");
  await insertOrder(merchantA, "completed", "va", "paid");
  await insertOrder(merchantA, "completed", "cod", "paid");
  await insertOrder(merchantB, "completed", "va", "paid");
  const cancelled = await insertOrder(merchantA, "cancelled", "va", "paid");
  await db.query(
    "INSERT INTO payments (order_id, method, provider, amount, status, paid_at) VALUES (?, 'va', 'midtrans', 20000, 'paid', UTC_TIMESTAMP())",
    [cancelled],
  );

  // Laporan chat: 2 laporan, satu dibuka admin → 1 belum dibuka.
  const reported = await insertOrder(merchantA, "confirmed", "cod", "unpaid");
  await db.query(
    "INSERT INTO order_chat_reports (order_id, reporter_role, reason) VALUES (?, 'customer', 'Kasar'), (?, 'merchant', 'Mengancam')",
    [reported, reported],
  );
  const [[opened]] = await db.query<RowDataPacket[]>("SELECT MIN(id) AS id FROM order_chat_reports");
  await get(`/chat-reports/${opened.id}`, superToken).expect(200);

  // Hasil AI: 2 menunggu, 1 disetujui.
  for (const status of ["menunggu", "menunggu", "disetujui"])
    await db.query("INSERT INTO ai_results (fitur, input_text, output_json, status) VALUES ('asisten', 'x', '{}', ?)", [
      status,
    ]);
});

describe("GET /admin/queues", () => {
  test("super: hitungan tiap antrean", async () => {
    const res = await get("/queues", superToken).expect(200);
    expect(res.body.data).toEqual({
      merchants_pending: 1,
      tickets_open: 2,
      chats_reported: 1,
      payouts_pending: 2,
      refunds_pending: 1,
      ai_results_pending: 2,
    });
  });

  test("angka sama dengan halaman tujuan", async () => {
    const queues = (await get("/queues", superToken).expect(200)).body.data;
    const tickets = await get("/tickets?status=open", superToken).expect(200);
    expect(queues.tickets_open).toBe(tickets.body.meta.counts.open);
    const aiResults = await get("/hasil-ai?status=menunggu", superToken).expect(200);
    expect(queues.ai_results_pending).toBe(aiResults.body.meta.total);
    const reports = await get("/chat-reports", superToken).expect(200);
    const unopened = reports.body.data.filter((report: { reviewed_at: string | null }) => report.reviewed_at === null);
    expect(queues.chats_reported).toBe(unopened.length);
    const balances = await get("/payouts/balances", superToken).expect(200);
    expect(queues.payouts_pending).toBe(balances.body.data.rows.length);
    const refunds = await get("/refunds", superToken).expect(200);
    expect(queues.refunds_pending).toBe(refunds.body.data.length);
    const pending = await get("/merchants?status=pending", superToken).expect(200);
    expect(queues.merchants_pending).toBe(pending.body.meta.total);
  });

  test("ops dan support: 200, payouts_pending dan refunds_pending null, angka lain sama dengan super", async () => {
    const superData = (await get("/queues", superToken).expect(200)).body.data;
    for (const token of [opsToken, supportToken]) {
      const res = await get("/queues", token).expect(200);
      expect(res.body.data).toEqual({ ...superData, payouts_pending: null, refunds_pending: null });
    }
  });

  test("tanpa token 401, token penjual 403", async () => {
    await request(app).get("/api/v1/admin/queues").expect(401);
    await get("/queues", merchantToken).expect(403);
  });
});
