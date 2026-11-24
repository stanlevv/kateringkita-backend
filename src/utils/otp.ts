// Isi file: bagian bersama kode OTP (kode 6 angka sekali pakai yang dikirim lewat email). Dipakai alur lupa sandi
// (password-reset.service) dan verifikasi/ganti email (email-verification.service), supaya aturan kode sama persis.
import bcrypt from "bcryptjs";
import { randomInt } from "node:crypto";
import { AppError } from "./errors";

// Tingkat kerja bcrypt (2^10 putaran), sama dengan hash kata sandi di auth.service.
const BCRYPT_COST = 10;

/**
 * Membuat kode OTP baru dari pembangkit acak kriptografis, beserta hash-nya untuk disimpan di database. Kode asli
 * hanya dikirim ke email dan tidak pernah disimpan.
 * @returns kode 6 angka (dengan nol di depan bila perlu) dan hash bcrypt-nya
 */
export async function createOtpCode(): Promise<{ code: string; codeHash: string }> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  return { code, codeHash: await bcrypt.hash(code, BCRYPT_COST) };
}

/**
 * Satu galat untuk semua kegagalan kode (tidak ada, kedaluwarsa, salah, jatah habis, sudah dipakai), supaya penebak
 * tidak bisa membedakan penyebabnya.
 * @returns galat 400 VALIDATION_ERROR di kolom `code`
 */
export const invalidOtpCodeError = () =>
  new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", { code: ["Kode salah atau sudah kedaluwarsa."] });
