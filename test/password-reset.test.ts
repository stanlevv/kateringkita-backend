import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { loginLimiter, otpLimiter } from "../src/middleware/rate-limiter";
import { mailer } from "../src/utils/mail";
import { login, prepareMerchants } from "./helpers/merchant";

// POST /auth/password/{forgot,verify,reset} — OTP email
const EMAIL = "budi@mail.com";
const sendSpy = vi.spyOn(mailer, "send").mockResolvedValue();
const post = (path: string, body: object) => request(app).post(`/api/v1/auth/password/${path}`).send(body);
const lastSentCode = () => String(sendSpy.mock.calls.at(-1)?.[2]).match(/\d{6}/)![0];
const requestCode = async () => {
  await post("forgot", { email: EMAIL }).expect(200);
  return lastSentCode();
};
const expectWrongCode = (res: request.Response) =>
  expect(res.body.error.fields).toEqual({ code: ["Kode salah atau sudah kedaluwarsa."] });

beforeAll(async () => {
  await prepareMerchants();
});
beforeEach(() => {
  otpLimiter.reset();
  loginLimiter.reset();
  sendSpy.mockClear();
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("forgot", () => {
  test("email terdaftar dan tidak: jawaban sama; hanya yang terdaftar dikirimi kode (hash di DB)", async () => {
    const genericReply = { data: { message: "Jika email terdaftar, kode verifikasi sudah dikirim." } };
    expect((await post("forgot", { email: "tidak.ada@mail.com" }).expect(200)).body).toEqual(genericReply);
    expect(sendSpy).not.toHaveBeenCalled();
    expect((await post("forgot", { email: " Budi@Mail.com " }).expect(200)).body).toEqual(genericReply);
    expect(sendSpy).toHaveBeenCalledWith(
      EMAIL,
      "Kode reset kata sandi KateringKita",
      expect.stringMatching(/\b\d{6}\b/),
    );
    const [[row]] = await db.query<any[]>("SELECT code_hash FROM password_resets ORDER BY id DESC LIMIT 1");
    expect(row.code_hash).not.toContain(lastSentCode());
  });

  test("validasi email; batas 5 permintaan per email", async () => {
    expect((await post("forgot", { email: "bukan-email" }).expect(400)).body.error.fields.email).toEqual([
      "Format email tidak valid.",
    ]);
    for (let i = 0; i < 5; i++) await post("forgot", { email: EMAIL }).expect(200);
    expect((await post("forgot", { email: EMAIL }).expect(429)).body.error.code).toBe("RATE_LIMITED");
  });

  // Varian path: router Express tidak peka huruf besar-kecil dan menerima garis miring akhir; varian path tidak boleh dapat bucket baru
  test("varian huruf besar dan garis miring akhir memakai batas per email yang sama", async () => {
    for (let i = 0; i < 5; i++) await post("forgot", { email: EMAIL }).expect(200);
    await request(app).post("/api/v1/AUTH/password/Forgot").send({ email: EMAIL }).expect(429);
    await request(app).post("/api/v1/auth/password/forgot/").send({ email: EMAIL }).expect(429);
  });
});

describe("verify & reset", () => {
  test("kode salah 400; benar 200; reset mengganti sandi, mencabut sesi, kode sekali pakai", async () => {
    const oldToken = await login(EMAIL);
    const otpCode = await requestCode();
    expectWrongCode(
      await post("verify", { email: EMAIL, code: otpCode === "000000" ? "111111" : "000000" }).expect(400),
    );
    expect((await post("verify", { email: EMAIL, code: otpCode }).expect(200)).body).toEqual({ data: { valid: true } });
    expect(
      (await post("reset", { email: EMAIL, code: otpCode, password: "pendek" }).expect(400)).body.error.fields.password,
    ).toBeDefined();
    await post("reset", { email: EMAIL, code: otpCode, password: "sandiBaru123" }).expect(200);
    await request(app).get("/api/v1/me").set("Authorization", `Bearer ${oldToken}`).expect(401);
    await request(app)
      .post("/api/v1/auth/login")
      .send({ identifier: EMAIL, password: "sandiBaru123", client: "web" })
      .expect(200);
    expectWrongCode(await post("reset", { email: EMAIL, code: otpCode, password: "sandiLain123" }).expect(400));
  });

  test("maks 5 percobaan per kode (benar pun ditolak sesudahnya)", async () => {
    const otpCode = await requestCode();
    const wrongCode = otpCode === "000000" ? "111111" : "000000";
    for (let i = 0; i < 3; i++) await post("verify", { email: EMAIL, code: wrongCode }).expect(400);
    for (let i = 0; i < 2; i++)
      await post("reset", { email: EMAIL, code: wrongCode, password: "sandiBaru123" }).expect(400);
    expectWrongCode(await post("verify", { email: EMAIL, code: otpCode }).expect(400));
  });

  test("kode lama hangus saat minta baru; kode kedaluwarsa ditolak", async () => {
    const oldCode = await requestCode();
    const newCode = await requestCode();
    if (oldCode !== newCode) expectWrongCode(await post("verify", { email: EMAIL, code: oldCode }).expect(400));
    await db.query(
      "UPDATE password_resets SET expires_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 SECOND) WHERE used_at IS NULL",
    );
    expectWrongCode(await post("verify", { email: EMAIL, code: newCode }).expect(400));
  });
});
