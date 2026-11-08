import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { loginLimiter, otpLimiter } from "../src/middleware/rateLimiter";
import { surel } from "../src/utils/mail";
import { login, siapkanToko } from "./helpers/toko";

// F11: POST /auth/password/{forgot,verify,reset} — OTP email
const EMAIL = "budi@mail.com";
const kirim = vi.spyOn(surel, "kirim").mockResolvedValue();
const post = (path: string, body: object) => request(app).post(`/api/v1/auth/password/${path}`).send(body);
const kodeTerakhir = () => String(kirim.mock.calls.at(-1)?.[2]).match(/\d{6}/)![0];
const minta = async () => {
  await post("forgot", { email: EMAIL }).expect(200);
  return kodeTerakhir();
};
const salah = (r: request.Response) => expect(r.body.error.fields).toEqual({ code: ["Kode salah atau sudah kedaluwarsa."] });

beforeAll(async () => {
  await siapkanToko();
});
beforeEach(() => {
  otpLimiter.reset();
  loginLimiter.reset();
  kirim.mockClear();
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("forgot", () => {
  test("email terdaftar dan tidak: jawaban sama; hanya yang terdaftar dikirimi kode (hash di DB)", async () => {
    const pesan = { data: { message: "Jika email terdaftar, kode verifikasi sudah dikirim." } };
    expect((await post("forgot", { email: "tidak.ada@mail.com" }).expect(200)).body).toEqual(pesan);
    expect(kirim).not.toHaveBeenCalled();
    expect((await post("forgot", { email: " Budi@Mail.com " }).expect(200)).body).toEqual(pesan);
    expect(kirim).toHaveBeenCalledWith(EMAIL, "Kode reset kata sandi KateringKita", expect.stringMatching(/\b\d{6}\b/));
    const [[r]] = await db.query<any[]>("SELECT code_hash FROM password_resets ORDER BY id DESC LIMIT 1");
    expect(r.code_hash).not.toContain(kodeTerakhir());
  });

  test("validasi email; batas 5 permintaan per email", async () => {
    expect((await post("forgot", { email: "bukan-email" }).expect(400)).body.error.fields.email).toEqual(["Format email tidak valid."]);
    for (let i = 0; i < 5; i++) await post("forgot", { email: EMAIL }).expect(200);
    expect((await post("forgot", { email: EMAIL }).expect(429)).body.error.code).toBe("RATE_LIMITED");
  });
});

describe("verify & reset", () => {
  test("kode salah 400; benar 200; reset mengganti sandi, mencabut sesi, kode sekali pakai", async () => {
    const tokenLama = await login(EMAIL);
    const kode = await minta();
    salah(await post("verify", { email: EMAIL, code: kode === "000000" ? "111111" : "000000" }).expect(400));
    expect((await post("verify", { email: EMAIL, code: kode }).expect(200)).body).toEqual({ data: { valid: true } });
    expect((await post("reset", { email: EMAIL, code: kode, password: "pendek" }).expect(400)).body.error.fields.password).toBeDefined();
    await post("reset", { email: EMAIL, code: kode, password: "sandiBaru123" }).expect(200);
    await request(app).get("/api/v1/me").set("Authorization", `Bearer ${tokenLama}`).expect(401);
    await request(app).post("/api/v1/auth/login").send({ identifier: EMAIL, password: "sandiBaru123", client: "web" }).expect(200);
    salah(await post("reset", { email: EMAIL, code: kode, password: "sandiLain123" }).expect(400));
  });

  test("maks 5 percobaan per kode (benar pun ditolak sesudahnya)", async () => {
    const kode = await minta();
    const keliru = kode === "000000" ? "111111" : "000000";
    for (let i = 0; i < 3; i++) await post("verify", { email: EMAIL, code: keliru }).expect(400);
    for (let i = 0; i < 2; i++) await post("reset", { email: EMAIL, code: keliru, password: "sandiBaru123" }).expect(400);
    salah(await post("verify", { email: EMAIL, code: kode }).expect(400));
  });

  test("kode lama hangus saat minta baru; kode kedaluwarsa ditolak", async () => {
    const lama = await minta();
    const baru = await minta();
    if (lama !== baru) salah(await post("verify", { email: EMAIL, code: lama }).expect(400));
    await db.query("UPDATE password_resets SET expires_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 SECOND) WHERE used_at IS NULL");
    salah(await post("verify", { email: EMAIL, code: baru }).expect(400));
  });
});
