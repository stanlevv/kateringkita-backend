import { RequestHandler } from "express";
import db from "../config/db";
import { AppError } from "../utils/errors";

export const healthHandler: RequestHandler = async (_req, res) => {
  try {
    await db.query("SELECT 1");
  } catch (error) {
    console.error(error);
    throw new AppError(503, "SERVICE_UNAVAILABLE", "Database tidak dapat dihubungi.");
  }
  res.json({ data: { status: "ok", db: "ok" } });
};
