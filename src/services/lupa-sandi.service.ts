import bcrypt from "bcryptjs";
import { randomInt } from "node:crypto";
import { ResultSetHeader, RowDataPacket } from "mysql2";
import db from "../config/db";
import { ResetPasswordInput } from "../dto/auth.dto";
import { AppError } from "../utils/errors";
import { surel } from "../utils/mail";

// F11 lupa sandi: OTP 6 digit via email, di-hash di password_resets, berlaku 10 menit, maks 5 percobaan, sekali pakai.
const BCRYPT_COST = 10;
const salahKode = () => new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", { code: ["Kode salah atau sudah kedaluwarsa."] });

// Email tak terdaftar → diam (jawaban handler sama, anti-enumerasi).
// shortcut: waktu respons masih bisa membedakan email terdaftar (hash + SMTP); upgrade ke antrean kirim bila enumerasi jadi masalah
export async function mintaOtp(email: string) {
  const [[u]] = await db.query<RowDataPacket[]>("SELECT id FROM users WHERE email = ? COLLATE utf8mb4_bin AND is_active = TRUE", [email]);
  if (!u) return;
  const kode = String(randomInt(0, 1_000_000)).padStart(6, "0");
  // kode lama hangus: hanya kode terbaru yang berlaku
  await db.query("UPDATE password_resets SET used_at = UTC_TIMESTAMP() WHERE user_id = ? AND used_at IS NULL", [u.id]);
  await db.query("INSERT INTO password_resets (user_id, code_hash, expires_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 10 MINUTE))",
    [u.id, await bcrypt.hash(kode, BCRYPT_COST)]);
  await surel.kirim(email, "Kode reset kata sandi KateringKita",
    `Kode reset kata sandi Anda: ${kode}\n\nBerlaku 10 menit. Abaikan email ini bila Anda tidak memintanya.`);
}

/** Cocokkan kode terbaru; setiap percobaan (benar atau salah) memakai satu jatah secara atomik. */
export async function cekOtp(email: string, code: string): Promise<{ id: number; user_id: number }> {
  const [[r]] = await db.query<RowDataPacket[]>(
    `SELECT r.id, r.user_id, r.code_hash FROM password_resets r JOIN users u ON u.id = r.user_id
     WHERE u.email = ? COLLATE utf8mb4_bin AND u.is_active = TRUE AND r.used_at IS NULL AND r.expires_at > UTC_TIMESTAMP()
     ORDER BY r.id DESC LIMIT 1`,
    [email],
  );
  if (!r) throw salahKode();
  const [jatah] = await db.query<ResultSetHeader>("UPDATE password_resets SET attempts = attempts + 1 WHERE id = ? AND attempts < 5", [r.id]);
  if (!jatah.affectedRows || !(await bcrypt.compare(code, r.code_hash))) throw salahKode();
  return { id: r.id, user_id: r.user_id };
}

export async function resetSandi(input: ResetPasswordInput) {
  const r = await cekOtp(input.email, input.code);
  // UPDATE bersyarat: dua reset paralel dengan kode sama → hanya satu yang lolos
  const [pakai] = await db.query<ResultSetHeader>("UPDATE password_resets SET used_at = UTC_TIMESTAMP() WHERE id = ? AND used_at IS NULL", [r.id]);
  if (!pakai.affectedRows) throw salahKode();
  // semua sesi dicabut lebih dulu, sama dengan changePassword
  await db.query("UPDATE auth_sessions SET revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND revoked_at IS NULL", [r.user_id]);
  await db.query("UPDATE users SET password_hash = ? WHERE id = ?", [await bcrypt.hash(input.password, BCRYPT_COST), r.user_id]);
}
