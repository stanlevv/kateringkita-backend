// Isi file: verifikasi email dan ganti email dengan kode OTP yang dikirim ke email. Alurnya routes/auth.ts →
// handlers/auth.handler.ts → file ini → database dan server email.
// Kode OTP (kode 6 angka sekali pakai) disimpan sebagai hash bcrypt di tabel email_verifications bersama alamat
// tujuannya. Kode berlaku 10 menit, boleh dicoba 5 kali, dan hanya kode terbaru yang berlaku. Bila alamat tujuan
// berbeda dengan email akun, kode yang benar sekaligus mengganti email akun.
import bcrypt from "bcryptjs";
import { ResultSetHeader, RowDataPacket } from "mysql2";
import db from "../config/db";
import { EmailOtpInput } from "../dto/auth.dto";
import { AppError } from "../utils/errors";
import { mailer } from "../utils/mail";
import { createOtpCode, invalidOtpCodeError } from "../utils/otp";
import { assertPassword, getMe } from "./auth.service";

const EMAIL_TAKEN_MSG = "Email sudah dipakai akun lain.";
const emailTakenError = () => new AppError(409, "CONFLICT", EMAIL_TAKEN_MSG, { email: [EMAIL_TAKEN_MSG] });

/**
 * Membuat kode OTP dan mengirimkannya ke email. Tanpa `email` (atau email yang sama dengan akun) kode dikirim ke email
 * akun untuk verifikasi. Email lain berarti ganti email: kata sandi saat ini wajib benar dan email itu belum dipakai
 * akun lain. Email akun belum berubah sampai kodenya diverifikasi.
 * @param userId id pengguna yang login
 * @param input  email tujuan (opsional) dan kata sandi saat ini (wajib bila email berbeda)
 * @returns alamat email yang dikirimi kode
 * @throws 400 VALIDATION_ERROR bila akun belum punya email dan tidak ada email yang dikirim, atau kata sandi tidak
 *         dikirim/salah; 409 CONFLICT (kolom `email`) bila email sudah dipakai akun lain; 503 bila pengiriman email
 *         belum diatur di production
 */
export async function requestEmailOtp(userId: number, input: EmailOtpInput): Promise<{ email: string }> {
  // 1. Tentukan alamat tujuan: email yang dikirim, atau email akun sekarang.
  const [[user]] = await db.query<RowDataPacket[]>("SELECT email, password_hash FROM users WHERE id = ?", [userId]);
  const email: string | null = input.email ?? user.email;
  if (!email) throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", { email: ["Isi email dulu."] });
  // 2. Ganti email: email dipakai untuk login, jadi wajib kata sandi saat ini dan email belum dipakai akun lain.
  if (email !== user.email) {
    if (input.current_password === undefined) {
      throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", {
        current_password: ["Masukkan kata sandi saat ini untuk mengubah email."],
      });
    }
    await assertPassword(input.current_password, user.password_hash);
    const [taken] = await db.query<RowDataPacket[]>("SELECT 1 FROM users WHERE email = ? AND id <> ? LIMIT 1", [
      email,
      userId,
    ]);
    if (taken.length) throw emailTakenError();
  }
  // 3. Hanguskan kode lama, simpan hash kode baru yang berlaku 10 menit, lalu kirim kode aslinya.
  const { code, codeHash } = await createOtpCode();
  await db.query("UPDATE email_verifications SET used_at = UTC_TIMESTAMP() WHERE user_id = ? AND used_at IS NULL", [
    userId,
  ]);
  await db.query(
    "INSERT INTO email_verifications (user_id, email, code_hash, expires_at) VALUES (?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 10 MINUTE))",
    [userId, email, codeHash],
  );
  await mailer.send(
    email,
    "Kode verifikasi email KateringKita",
    `Kode verifikasi email Anda: ${code}\n\nBerlaku 10 menit. Abaikan email ini bila Anda tidak memintanya.`,
  );
  return { email };
}

/**
 * Memeriksa kode OTP terbaru milik pengguna. Bila benar, email akun ditandai terverifikasi, dan bila kodenya dikirim
 * ke email lain, email akun diganti ke alamat itu. Setiap percobaan memakai satu dari 5 jatah.
 * @param userId id pengguna yang login
 * @param code   kode 6 angka yang diketik pengguna
 * @returns profil terbaru, sama bentuknya dengan `GET /me`
 * @throws 400 VALIDATION_ERROR (kolom `code`) bila tidak ada kode yang berlaku, jatah habis, atau kode salah;
 *         409 CONFLICT (kolom `email`) bila email tujuan keburu dipakai akun lain
 */
export async function verifyEmailOtp(userId: number, code: string) {
  // 1. Ambil kode terbaru yang belum dipakai dan belum kedaluwarsa.
  const [[verification]] = await db.query<RowDataPacket[]>(
    `SELECT id, email, code_hash FROM email_verifications
     WHERE user_id = ? AND used_at IS NULL AND expires_at > UTC_TIMESTAMP() ORDER BY id DESC LIMIT 1`,
    [userId],
  );
  if (!verification) throw invalidOtpCodeError();
  // 2. Pakai satu jatah percobaan dengan UPDATE bersyarat, supaya percobaan bersamaan tidak melewati batas 5.
  const [attemptUpdate] = await db.query<ResultSetHeader>(
    "UPDATE email_verifications SET attempts = attempts + 1 WHERE id = ? AND attempts < 5",
    [verification.id],
  );
  if (!attemptUpdate.affectedRows || !(await bcrypt.compare(code, verification.code_hash))) throw invalidOtpCodeError();
  // 3. Tandai kode terpakai; bila permintaan lain keburu memakainya, tolak.
  const [markUsed] = await db.query<ResultSetHeader>(
    "UPDATE email_verifications SET used_at = UTC_TIMESTAMP() WHERE id = ? AND used_at IS NULL",
    [verification.id],
  );
  if (!markUsed.affectedRows) throw invalidOtpCodeError();
  // 4. Simpan email tujuan sebagai email akun yang sudah terverifikasi. Indeks unik email menjaga bila email itu
  //    keburu dipakai akun lain sejak kode dikirim.
  try {
    await db.query("UPDATE users SET email = ?, email_verified_at = UTC_TIMESTAMP() WHERE id = ?", [
      verification.email,
      userId,
    ]);
  } catch (error) {
    if ((error as { code?: string }).code === "ER_DUP_ENTRY") throw emailTakenError();
    throw error;
  }
  return getMe(userId);
}
