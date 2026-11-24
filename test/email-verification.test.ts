import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { emailOtpLimiter, loginLimiter } from "../src/middleware/rate-limiter";
import { mailer } from "../src/utils/mail";
import { login, prepareMerchants } from "./helpers/merchant";

// POST /me/email/otp dan /me/email/verify — verifikasi email dan ganti email dengan kode OTP
const sendSpy = vi.spyOn(mailer, "send").mockResolvedValue();
let merchantToken: string;
let otherMerchantToken: string;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const sendOtp = (body: object, token = merchantToken) =>
  request(app).post("/api/v1/me/email/otp").set(auth(token)).send(body);
const verify = (code: string, token = merchantToken) =>
  request(app).post("/api/v1/me/email/verify").set(auth(token)).send({ code });
const lastSentCode = () => String(sendSpy.mock.calls.at(-1)?.[2]).match(/\d{6}/)![0];
const getMe = async (token = merchantToken) =>
  (await request(app).get("/api/v1/me").set(auth(token)).expect(200)).body.data.user;
const wrongCode = { code: ["Kode salah atau sudah kedaluwarsa."] };

beforeAll(async () => {
  ({ tokenA: merchantToken, tokenB: otherMerchantToken } = await prepareMerchants());
});
beforeEach(() => {
  emailOtpLimiter.reset();
  loginLimiter.reset();
  sendSpy.mockClear();
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("verifikasi email sendiri", () => {
  test("akun baru belum terverifikasi; kode dikirim ke email akun; kode salah ditolak; kode benar memverifikasi", async () => {
    expect((await getMe()).email_verified).toBe(false);
    expect((await sendOtp({}).expect(200)).body.data).toEqual({ email: "siti@mail.com" });
    expect(sendSpy).toHaveBeenCalledWith("siti@mail.com", "Kode verifikasi email KateringKita", expect.any(String));
    const [[row]] = await db.query<any[]>("SELECT code_hash FROM email_verifications ORDER BY id DESC LIMIT 1");
    expect(row.code_hash).not.toBe(lastSentCode());
    const code = lastSentCode();
    expect((await verify(code === "000000" ? "111111" : "000000").expect(400)).body.error.fields).toEqual(wrongCode);
    expect((await verify(code).expect(200)).body.data.user).toMatchObject({
      email: "siti@mail.com",
      email_verified: true,
    });
    expect((await getMe()).email_verified).toBe(true);
    // kode sekali pakai
    expect((await verify(code).expect(400)).body.error.fields).toEqual(wrongCode);
  });

  test("tanpa email (penjual boleh tanpa email) → 400 fields.email; tanpa token → 401", async () => {
    await db.query("UPDATE users SET email = NULL WHERE email = 'andi@mail.com'");
    expect((await sendOtp({}, otherMerchantToken).expect(400)).body.error.fields.email).toEqual(["Isi email dulu."]);
    await request(app).post("/api/v1/me/email/otp").send({}).expect(401);
    await request(app).post("/api/v1/me/email/verify").send({ code: "123456" }).expect(401);
    await db.query("UPDATE users SET email = 'andi@mail.com' WHERE phone = '081211112222'");
  });
});

describe("ganti email", () => {
  test("email baru wajib sandi saat ini; kode dikirim ke email baru; email akun baru berubah setelah verifikasi", async () => {
    expect(
      (await sendOtp({ email: "siti.baru@mail.com" }).expect(400)).body.error.fields.current_password,
    ).toBeDefined();
    expect(
      (await sendOtp({ email: "siti.baru@mail.com", current_password: "salah123" }).expect(400)).body.error.fields
        .current_password,
    ).toEqual(["Kata sandi lama salah."]);
    expect(sendSpy).not.toHaveBeenCalled();
    await sendOtp({ email: " Siti.Baru@Mail.com ", current_password: "rahasia123" }).expect(200);
    expect(sendSpy).toHaveBeenCalledWith("siti.baru@mail.com", expect.any(String), expect.any(String));
    // belum berubah sebelum kode dimasukkan
    expect((await getMe()).email).toBe("siti@mail.com");
    const res = await verify(lastSentCode()).expect(200);
    expect(res.body.data.user).toMatchObject({ email: "siti.baru@mail.com", email_verified: true });
    expect(await login("siti.baru@mail.com")).toBeTruthy();
  });

  test("email milik akun lain → 409 saat minta kode dan saat verifikasi (bila keburu dipakai)", async () => {
    expect(
      (await sendOtp({ email: "andi@mail.com", current_password: "rahasia123" }).expect(409)).body.error.fields.email,
    ).toEqual(["Email sudah dipakai akun lain."]);
    await sendOtp({ email: "rebutan@mail.com", current_password: "rahasia123" }).expect(200);
    const code = lastSentCode();
    await db.query("UPDATE users SET email = 'rebutan@mail.com' WHERE phone = '081211112222'");
    expect((await verify(code).expect(409)).body.error.fields.email).toEqual(["Email sudah dipakai akun lain."]);
    await db.query("UPDATE users SET email = 'andi@mail.com' WHERE phone = '081211112222'");
  });

  test("hanya kode terbaru yang berlaku; 5 kali salah menghanguskan kode", async () => {
    await sendOtp({}).expect(200);
    const oldCode = lastSentCode();
    await sendOtp({}).expect(200);
    const newCode = lastSentCode();
    if (oldCode !== newCode) await verify(oldCode).expect(400);
    const wrong = newCode === "000000" ? "111111" : "000000";
    for (let i = 0; i < 4; i++) await verify(wrong).expect(400);
    await verify(newCode).expect(400);
  });

  test("PATCH /me yang mengganti email (dipakai aplikasi mobile) mereset status verifikasi", async () => {
    await sendOtp({}).expect(200);
    await verify(lastSentCode()).expect(200);
    expect((await getMe()).email_verified).toBe(true);
    await request(app)
      .patch("/api/v1/me")
      .set(auth(merchantToken))
      .send({ email: "siti.lagi@mail.com", current_password: "rahasia123" })
      .expect(200);
    expect(await getMe()).toMatchObject({ email: "siti.lagi@mail.com", email_verified: false });
  });

  test("batas 5 permintaan kode per pengguna per 15 menit → 429", async () => {
    for (let i = 0; i < 5; i++) await sendOtp({}).expect(200);
    expect((await sendOtp({}).expect(429)).body.error.code).toBe("RATE_LIMITED");
    await sendOtp({}, otherMerchantToken).expect(200);
  });
});
