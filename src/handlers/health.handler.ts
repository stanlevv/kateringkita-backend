// Isi file: handler cek kesehatan server `GET /api/v1/health`. Dipasang langsung di app.ts (tanpa routes dan
// services) dan sebelum pemeriksa mode pemeliharaan, supaya pemantau server tetap bisa memanggilnya.
import { RequestHandler } from "express";
import db from "../config/db";
import { AppError } from "../utils/errors";

/**
 * Memastikan server hidup dan database bisa dihubungi dengan menjalankan query paling ringan (`SELECT 1`).
 * @param _req request masuk (tidak dibaca)
 * @param res  respons berisi `{ data: { status: "ok", db: "ok" } }`
 * @returns Promise yang selesai setelah jawaban terkirim
 * @throws 503 SERVICE_UNAVAILABLE bila database tidak menjawab; galat aslinya hanya dicetak ke log server
 */
export const healthHandler: RequestHandler = async (_req, res) => {
  try {
    await db.query("SELECT 1");
  } catch (error) {
    console.error(error);
    throw new AppError(503, "SERVICE_UNAVAILABLE", "Database tidak dapat dihubungi.");
  }
  res.json({ data: { status: "ok", db: "ok" } });
};
