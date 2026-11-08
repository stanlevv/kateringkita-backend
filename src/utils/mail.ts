import nodemailer from "nodemailer";
import { env } from "../config/env";
import { AppError } from "./errors";

// F11: kirim email teks lewat SMTP (env dibaca saat dipanggil, seperti R2). Objek agar test bisa memata-matai `kirim`.
export const surel = {
  async kirim(to: string, subject: string, text: string): Promise<void> {
    if (!env.SMTP_HOST) {
      if (env.NODE_ENV === "production") throw new AppError(503, "SERVICE_UNAVAILABLE", "Pengiriman email belum diaktifkan.");
      console.info(`[surel] ke ${to} — ${subject}\n${text}`);
      return;
    }
    await nodemailer
      .createTransport({ host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_PORT === 465, auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } })
      .sendMail({ from: env.SMTP_FROM, to, subject, text });
  },
};
