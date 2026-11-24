// Isi file: alur lupa kata sandi lewat kode OTP yang dikirim ke email. Alurnya routes/auth.ts →
// handlers/auth.handler.ts → file ini → database dan server email.
// OTP (one-time password) di sini adalah kode 6 angka sekali pakai. Kode tidak disimpan apa adanya, melainkan sebagai
// hash bcrypt (acakan satu arah) di tabel password_resets. Kode kedaluwarsa (tidak berlaku lagi) setelah 10 menit,
// hanya boleh dicoba 5 kali, dan hangus setelah dipakai sekali.
import bcrypt from "bcryptjs";
import { ResultSetHeader, RowDataPacket } from "mysql2";
import db from "../config/db";
import { ResetPasswordInput } from "../dto/auth.dto";
import { mailer } from "../utils/mail";
import { createOtpCode, invalidOtpCodeError } from "../utils/otp";

// Tingkat kerja bcrypt (2^10 putaran) untuk hash kata sandi baru, sama dengan auth.service.
const BCRYPT_COST = 10;

/**
 * Membuat kode OTP baru untuk sebuah email dan mengirimkannya lewat email. Bila email tidak terdaftar atau akunnya
 * nonaktif, fungsi ini diam saja tanpa galat. Handler menjawab dengan kalimat yang sama untuk kedua keadaan, supaya
 * orang lain tidak bisa memakai fitur ini untuk mengecek email mana yang terdaftar (enumerasi akun).
 * @param email alamat email yang diketik pengguna (sudah huruf kecil dari skema)
 * @returns tidak ada nilai; selesai setelah kode disimpan dan email terkirim, atau langsung bila email tidak terdaftar
 * @throws 503 SERVICE_UNAVAILABLE bila pengiriman email belum diatur di production; galat server email (SMTP)
 *         diteruskan apa adanya. Kode yang sudah tersimpan tetap ada, tetapi tidak sampai ke pengguna.
 */
// shortcut: waktu respons masih bisa membedakan email terdaftar (hash + SMTP); upgrade ke antrean kirim bila enumerasi jadi masalah
export async function requestOtp(email: string) {
  // 1. Cari akun aktif dengan email yang persis sama (dibandingkan biner, lihat login di auth.service).
  const [[user]] = await db.query<RowDataPacket[]>(
    "SELECT id FROM users WHERE email = ? COLLATE utf8mb4_bin AND is_active = TRUE",
    [email],
  );
  if (!user) return;
  // 2. Buat kode 6 angka acak beserta hash-nya.
  const { code, codeHash } = await createOtpCode();
  // 3. Hanguskan kode lama yang belum dipakai: hanya kode terbaru yang berlaku.
  await db.query("UPDATE password_resets SET used_at = UTC_TIMESTAMP() WHERE user_id = ? AND used_at IS NULL", [
    user.id,
  ]);
  // 4. Simpan hash kode baru yang berlaku 10 menit (waktu UTC).
  await db.query(
    "INSERT INTO password_resets (user_id, code_hash, expires_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 10 MINUTE))",
    [user.id, codeHash],
  );
  // 5. Kirim kode asli ke email pengguna.
  await mailer.send(
    email,
    "Kode reset kata sandi KateringKita",
    `Kode reset kata sandi Anda: ${code}\n\nBerlaku 10 menit. Abaikan email ini bila Anda tidak memintanya.`,
  );
}

/**
 * Memeriksa kode OTP terbaru milik sebuah email. Setiap percobaan, benar atau salah, memakai satu dari 5 jatah.
 * Jatah dikurangi dengan satu UPDATE bersyarat, sehingga banyak percobaan bersamaan tidak bisa melewati batas 5.
 * Fungsi ini tidak menandai kode sebagai terpakai; itu dilakukan {@link resetPassword}.
 * @param email email pemilik kode
 * @param code  kode 6 angka yang diketik pengguna
 * @returns id baris password_resets dan id pengguna pemilik kode
 * @throws 400 VALIDATION_ERROR (kolom `code`) bila tidak ada kode yang masih berlaku, jatah percobaan habis, atau kode
 *         salah
 */
export async function verifyOtp(email: string, code: string): Promise<{ id: number; user_id: number }> {
  // 1. Ambil kode terbaru yang belum dipakai dan belum kedaluwarsa, milik akun aktif dengan email ini.
  const [[reset]] = await db.query<RowDataPacket[]>(
    `SELECT r.id, r.user_id, r.code_hash FROM password_resets r JOIN users u ON u.id = r.user_id
     WHERE u.email = ? COLLATE utf8mb4_bin AND u.is_active = TRUE AND r.used_at IS NULL AND r.expires_at > UTC_TIMESTAMP()
     ORDER BY r.id DESC LIMIT 1`,
    [email],
  );
  if (!reset) throw invalidOtpCodeError();
  // 2. Pakai satu jatah percobaan; bila sudah 5 kali dicoba, tidak ada baris yang berubah dan kode ditolak.
  const [attemptUpdate] = await db.query<ResultSetHeader>(
    "UPDATE password_resets SET attempts = attempts + 1 WHERE id = ? AND attempts < 5",
    [reset.id],
  );
  // 3. Cocokkan kode yang diketik dengan hash tersimpan.
  if (!attemptUpdate.affectedRows || !(await bcrypt.compare(code, reset.code_hash))) throw invalidOtpCodeError();
  return { id: reset.id, user_id: reset.user_id };
}

/**
 * Mengganti kata sandi dengan kode OTP, lalu mencabut semua sesi login pengguna itu di semua perangkat.
 * Tanda wajib ganti sandi (`must_change_password`) ikut dimatikan.
 * @param input email, kode OTP, dan kata sandi baru
 * @returns tidak ada nilai; selesai setelah sandi diganti dan sesi dicabut
 * @throws 400 VALIDATION_ERROR (kolom `code`) bila kode tidak berlaku, salah, jatahnya habis, atau sudah dipakai
 *         permintaan lain
 */
export async function resetPassword(input: ResetPasswordInput) {
  // 1. Periksa kode (memakai satu jatah percobaan).
  const reset = await verifyOtp(input.email, input.code);
  // 2. Tandai kode sebagai terpakai dengan UPDATE bersyarat: bila dua reset berjalan bersamaan dengan kode yang sama,
  //    hanya satu yang berhasil mengubah baris dan yang lain ditolak.
  const [markUsed] = await db.query<ResultSetHeader>(
    "UPDATE password_resets SET used_at = UTC_TIMESTAMP() WHERE id = ? AND used_at IS NULL",
    [reset.id],
  );
  if (!markUsed.affectedRows) throw invalidOtpCodeError();
  // 3. Urutannya sama dengan changePassword di auth.service: tulis hash baru dulu, baru cabut semua sesi.
  await db.query("UPDATE users SET password_hash = ?, must_change_password = FALSE WHERE id = ?", [
    await bcrypt.hash(input.password, BCRYPT_COST),
    reset.user_id,
  ]);
  await db.query("UPDATE auth_sessions SET revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND revoked_at IS NULL", [
    reset.user_id,
  ]);
}
