import request from "supertest";
import { beforeAll, expect, test } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { migrate } from "../src/db/migrate";
import { createAdmin } from "../src/admin/create";
import { loginLimiter } from "../src/auth/rateLimit";
import { rentangHariWib, ringkasan, sedangBuka } from "../src/admin/summary";
import { resetTestDatabase } from "./helpers/db";

let token: string;
let merchantIds: number[] = [];
const A = () => ({ Authorization: `Bearer ${token}` });
const T = Date.parse("2026-05-10T05:00:00Z"); // 12:00 WIB, tetap
const utc = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");

test("rentangHariWib: 00:00 WIB = 17:00 UTC hari sebelumnya", () => {
  const r = rentangHariWib(Date.parse("2026-05-10T20:00:00Z")); // 11 Mei 03:00 WIB
  expect(r.from.toISOString()).toBe("2026-05-10T17:00:00.000Z");
  expect(r.to.toISOString()).toBe("2026-05-11T17:00:00.000Z");
  const s = rentangHariWib(Date.parse("2026-05-10T16:59:00Z")); // 10 Mei 23:59 WIB
  expect(s.from.toISOString()).toBe("2026-05-09T17:00:00.000Z");
});

test("sedangBuka: jam WIB, lewat tengah malam", () => {
  const t = Date.parse("2026-05-10T03:00:00Z"); // 10:00 WIB
  expect(sedangBuka(t, "07:00:00", "16:00:00")).toBe(true);
  expect(sedangBuka(t, "11:00:00", "16:00:00")).toBe(false);
  expect(sedangBuka(t, "22:00:00", "11:00:00")).toBe(true);
  expect(sedangBuka(t, "10:30:00", "02:00:00")).toBe(false);
  const malam = Date.parse("2026-05-09T18:00:00Z"); // 01:00 WIB
  expect(sedangBuka(malam, "18:00:00", "02:00:00")).toBe(true);
  expect(sedangBuka(malam, "18:00:00", "00:30:00")).toBe(false);
});

beforeAll(async () => {
  await migrate(await resetTestDatabase());
  loginLimiter.reset();
  await createAdmin({ phone: "081300000009", fullName: "Admin Uji", password: "rahasia123" });
  token = (await request(app).post("/api/v1/auth/login").send({ identifier: "081300000009", password: "rahasia123", client: "web" })).body.data.token;
  for (const [i, n] of ["Siti", "Andi", "Budi"].entries()) {
    await request(app).post("/api/v1/auth/merchant/register").send({
      full_name: n, email: `${n}@mail.com`, phone: `08121111222${i}`, password: "rahasia123",
      business_name: `Dapur ${n}`, merchant_type_id: 1, address: "Jl. Mawar 1",
    }).expect(201);
  }
  merchantIds = ((await db.query<any[]>("SELECT id FROM merchants ORDER BY id"))[0] as any[]).map((r) => r.id);
  // jam buka lebar; waktu ringkasan dibekukan (T) sehingga tidak bergantung jam uji
  await db.query("UPDATE merchants SET verification_status='verified', open_time='00:00:00', close_time='23:59:00', is_open=1 WHERE id=?", [merchantIds[0]]);
  await db.query("UPDATE merchants SET verification_status='suspended', open_time='00:00:00', close_time='23:59:00', is_open=1 WHERE id=?", [merchantIds[1]]);
  // Budi tetap pending
  const [cust] = await db.query<any>("INSERT INTO users (role, full_name, phone, password_hash) VALUES ('customer','Pembeli','081355550000','x')");
  const cid = cust.insertId;
  const o = async (code: string, status: string, total: number, createdAt: Date, holdUntil: Date) =>
    db.query(
      "INSERT INTO orders (code, customer_id, merchant_id, pickup_point_id, status, customer_name, customer_phone, subtotal, total, payment_method, hold_until, created_at) VALUES (?, ?, ?, 1, ?, 'P', '081355550000', ?, ?, 'cod', ?, ?)",
      [code, cid, merchantIds[0], status, total, total, utc(holdUntil), utc(createdAt)],
    );
  const now = new Date(T);
  const long = new Date(T + 3600e3);
  await o("KK-T-0001", "completed", 30000, now, long);
  await o("KK-T-0002", "completed", 20000, now, long);
  await o("KK-T-0003", "completed", 99999, new Date(T - 3 * 86400e3), long); // bukan hari ini
  await o("KK-T-0004", "cancelled", 5000, now, long);
  await o("KK-T-0005", "holding", 7000, now, new Date(T + 30e3)); // segera habis
  await o("KK-T-0006", "holding", 7000, now, long);
  await o("KK-T-0007", "holding", 7000, now, new Date(T - 30e3)); // sudah lewat
});

test("ringkasan", async () => {
  await db.query("INSERT INTO admin_audit_logs (admin_user_id, action, target_type, target_id) SELECT id, 'x.y', 'merchant', '1' FROM users WHERE role='admin'");
  await request(app).get("/api/v1/admin/summary").set(A()).expect(200);
  const r = JSON.parse(JSON.stringify(await ringkasan(T)));
  expect(r.orders_today).toEqual({ holding: 3, confirmed: 0, cooking: 0, ready: 0, completed: 2, cancelled: 1, expired: 0 });
  expect(r.revenue_today).toBe(50000);
  expect(r.merchants).toEqual({ pending: 1, needs_fix: 0, verified: 1, suspended: 1, open_now: 1 });
  expect(r.holding_expiring_soon).toBe(1);
  expect(r.recent_logs).toHaveLength(1);
  expect(r.recent_logs[0].admin_name).toBe("Admin Uji");
});
