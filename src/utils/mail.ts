// Isi file: pengirim email teks lewat server email (SMTP). Dipakai password-reset.service untuk mengirim kode OTP.
import nodemailer from "nodemailer";
import { env } from "../config/env";
import { AppError } from "./errors";

/**
 * Pengirim email. Dibuat sebagai objek (bukan fungsi lepas) supaya test bisa memata-matai `mailer.send` dan
 * tidak benar-benar mengirim email. Pengaturan SMTP dibaca setiap kali dipanggil, bukan saat file dimuat.
 */
export const mailer = {
  /**
   * Mengirim satu email teks biasa. Bila SMTP belum diatur: di production dilempar 503, di luar production isi email
   * hanya ditulis ke log supaya pengembang bisa melihat kodenya.
   * @param recipient alamat email tujuan
   * @param subject   judul email
   * @param text      isi email
   * @throws 503 SERVICE_UNAVAILABLE bila SMTP belum diatur di production; galat SMTP diteruskan apa adanya
   */
  async send(recipient: string, subject: string, text: string): Promise<void> {
    // 1. SMTP belum diatur: tolak di production, selain itu tulis isi email ke log.
    if (!env.SMTP_HOST) {
      if (env.NODE_ENV === "production")
        throw new AppError(503, "SERVICE_UNAVAILABLE", "Pengiriman email belum diaktifkan.");
      console.info(`[surel] ke ${recipient} — ${subject}\n${text}`);
      return;
    }
    // 2. Kirim lewat SMTP. Port 465 memakai TLS sejak awal sambungan; port lain (biasanya 587) menaikkan ke TLS
    //    setelah tersambung.
    await nodemailer
      .createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_PORT === 465,
        auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
      })
      .sendMail({ from: env.SMTP_FROM, to: recipient, subject, text });
  },
};
