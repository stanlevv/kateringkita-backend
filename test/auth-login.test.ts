import bcrypt from "bcryptjs";
import request from "supertest";
import { RowDataPacket } from "mysql2";
import { beforeEach, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { migrate } from "../src/scripts/migrate";
import { loginLimiter } from "../src/middleware/rate-limiter";
import { env } from "../src/config/env";
import { resetTestDatabase } from "./helpers/db";

const DAY = 86_400_000;
const GENERIC = "Email/WA atau password salah.";

beforeEach(async () => {
  await migrate(await resetTestDatabase());
  loginLimiter.reset();
  const res = await request(app)
    .post("/api/v1/auth/customer/register")
    .send({ full_name: "Budi", email: "budi@mail.com", phone: "081234567890", password: "rahasia123" });
  expect(res.status).toBe(201);
});

const SECRET = "rahasia-internal-minimal-32-karakter-aman";
const loginFrom = (clientIp: string, body: object, secret: string | null = SECRET) => {
  const req = request(app).post("/api/v1/auth/login").set("X-Client-IP", clientIp);
  return (secret === null ? req : req.set("X-Internal-Secret", secret)).send(body);
};
const wrongBody = { identifier: "budi@mail.com", password: "salah12345", client: "web" };
const correctBody = { identifier: "budi@mail.com", password: "rahasia123", client: "web" };

const login = (body: object) => request(app).post("/api/v1/auth/login").send(body);
const sessions = async () => {
  const [rows] = await db.query<RowDataPacket[]>("SELECT client, user_agent FROM auth_sessions");
  return rows;
};

test("login email web → 200, token, expires_at ±1 hari, 1 sesi web", async () => {
  const res = await login({ identifier: " Budi@Mail.com ", password: "rahasia123", client: "web" });
  expect(res.status).toBe(200);
  expect(typeof res.body.data.token).toBe("string");
  expect(res.body.data.user.email).toBe("budi@mail.com");
  expect(res.body.data.user).not.toHaveProperty("password_hash");
  expect(Math.abs(new Date(res.body.data.expires_at).getTime() - (Date.now() + DAY))).toBeLessThan(60_000);
  const rows = await sessions();
  expect(rows).toHaveLength(1);
  expect(rows[0].client).toBe("web");
});

test("login mobile → expires_at ±30 hari, sesi mobile", async () => {
  const res = await login({ identifier: "budi@mail.com", password: "rahasia123", client: "mobile" });
  expect(res.status).toBe(200);
  expect(Math.abs(new Date(res.body.data.expires_at).getTime() - (Date.now() + 30 * DAY))).toBeLessThan(60_000);
  expect((await sessions())[0].client).toBe("mobile");
});

test("login dengan no WA berformat → 200", async () => {
  const res = await login({ identifier: "0812-3456-7890", password: "rahasia123", client: "web" });
  expect(res.status).toBe(200);
});

test("password salah dan email tak dikenal → 401 identik", async () => {
  const wrongPassword = await login({ identifier: "budi@mail.com", password: "salah12345", client: "web" });
  const unknownEmail = await login({ identifier: "tidak@ada.com", password: "rahasia123", client: "web" });
  for (const res of [wrongPassword, unknownEmail]) {
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
    expect(res.body.error.message).toBe(GENERIC);
  }
});

test("akun nonaktif → 401 sama", async () => {
  await db.query("UPDATE users SET is_active = FALSE");
  const res = await login({ identifier: "budi@mail.com", password: "rahasia123", client: "web" });
  expect(res.status).toBe(401);
  expect(res.body.error.message).toBe(GENERIC);
});

test("login gagal tanpa baris pengguna tetap menjalankan bcrypt.compare sekali", async () => {
  const spy = vi.spyOn(bcrypt, "compare");
  await login({ identifier: "tidak@ada.com", password: "rahasia123", client: "web" });
  expect(spy).toHaveBeenCalledTimes(1);
  spy.mockClear();
  await db.query("UPDATE users SET is_active = FALSE");
  await login({ identifier: "budi@mail.com", password: "rahasia123", client: "web" });
  expect(spy).toHaveBeenCalledTimes(1);
  spy.mockRestore();
});

test("expires_at tersimpan UTC (±1 hari dari UTC_TIMESTAMP)", async () => {
  await login({ identifier: "budi@mail.com", password: "rahasia123", client: "web" });
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), expires_at) AS s FROM auth_sessions",
  );
  expect(Math.abs(rows[0].s - 86400)).toBeLessThan(60);
});

test("6× salah → percobaan ke-6 429; identifier lain tetap 401", async () => {
  for (let i = 0; i < 5; i++) {
    expect((await login({ identifier: "budi@mail.com", password: "salah12345", client: "web" })).status).toBe(401);
  }
  const sixth = await login({ identifier: " BUDI@mail.com", password: "rahasia123", client: "web" });
  expect(sixth.status).toBe(429);
  expect(sixth.body.error.code).toBe("RATE_LIMITED");
  const other = await login({ identifier: "lain@mail.com", password: "salah12345", client: "web" });
  expect(other.status).toBe(401);
});

test("email beraksen dengan password benar → 401 generik, bukan 200", async () => {
  const res = await login({ identifier: "búdi@màil.cóm", password: "rahasia123", client: "web" });
  expect(res.status).toBe(401);
  expect(res.body.error.message).toBe(GENERIC);
});

test.each([["\u0001"], ["\u007f"]])("karakter kontrol %j di email dengan password benar → 401", async (controlChar) => {
  const res = await login({ identifier: `bu${controlChar}di@mail.com`, password: "rahasia123", client: "web" });
  expect(res.status).toBe(401);
  expect(res.body.error.message).toBe(GENERIC);
});

test("varian aksen memakai bucket limiter yang sama → 429", async () => {
  for (let i = 0; i < 5; i++) {
    expect((await login({ identifier: "budi@mail.com", password: "salah12345", client: "web" })).status).toBe(401);
  }
  const res = await login({ identifier: "búdi@mail.com", password: "salah12345", client: "web" });
  expect(res.status).toBe(429);
});

test("identifier 300 karakter → 400 VALIDATION_ERROR", async () => {
  const res = await login({ identifier: "a".repeat(300) + "@mail.com", password: "rahasia123", client: "web" });
  expect(res.status).toBe(400);
  expect(res.body.error.code).toBe("VALIDATION_ERROR");
});

test("login berhasil tidak memakan jatah (5 berhasil lalu salah → 401)", async () => {
  for (let i = 0; i < 5; i++) expect((await login(correctBody)).status).toBe(200);
  expect((await login(wrongBody)).status).toBe(401);
});

test("X-Client-IP dipercaya hanya bila secret cocok; bucket per IP klien", async () => {
  env.INTERNAL_API_SECRET = SECRET;
  try {
    for (let i = 0; i < 5; i++) expect((await loginFrom("203.0.113.1", wrongBody)).status).toBe(401);
    expect((await loginFrom("203.0.113.1", wrongBody)).status).toBe(429);
    expect((await loginFrom("203.0.113.2", wrongBody)).status).toBe(401);
  } finally {
    env.INTERNAL_API_SECRET = undefined;
  }
});

test("X-Client-IP diabaikan bila secret salah/kosong/tak dikonfigurasi", async () => {
  env.INTERNAL_API_SECRET = SECRET;
  try {
    for (const secret of ["salah-salah-salah-salah-salah-salah-1", "x".repeat(SECRET.length), "pendek", null]) {
      loginLimiter.reset();
      for (let i = 0; i < 5; i++) expect((await loginFrom(`203.0.113.${i + 10}`, wrongBody, secret)).status).toBe(401);
      expect((await loginFrom("203.0.113.99", wrongBody, secret)).status).toBe(429);
    }
    env.INTERNAL_API_SECRET = undefined;
    loginLimiter.reset();
    for (let i = 0; i < 5; i++) expect((await loginFrom(`203.0.113.${i + 10}`, wrongBody)).status).toBe(401);
    expect((await loginFrom("203.0.113.99", wrongBody)).status).toBe(429);
  } finally {
    env.INTERNAL_API_SECRET = undefined;
  }
});

test("10 gagal dari 10 IP → IP baru 429 walau sandi benar; varian aksen ikut", async () => {
  env.INTERNAL_API_SECRET = SECRET;
  try {
    for (let i = 0; i < 10; i++) expect((await loginFrom(`198.51.100.${i + 1}`, wrongBody)).status).toBe(401);
    expect((await loginFrom("198.51.100.200", correctBody)).status).toBe(429);
    expect((await loginFrom("198.51.100.201", { ...correctBody, identifier: "búdi@mail.com" })).status).toBe(429);
  } finally {
    env.INTERNAL_API_SECRET = undefined;
  }
});

test("8 login salah paralel dari satu IP → tepat 5×401, sisanya 429", async () => {
  const responses = await Promise.all(Array.from({ length: 8 }, () => login(wrongBody)));
  expect(responses.filter((res) => res.status === 401)).toHaveLength(5);
  expect(responses.filter((res) => res.status === 429)).toHaveLength(3);
  expect((await login(wrongBody)).status).toBe(429);
});
