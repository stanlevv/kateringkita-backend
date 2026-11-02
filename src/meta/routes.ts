import { Router } from "express";
import { RowDataPacket } from "mysql2";
import db from "../config/db";

export const meta = Router();

meta.get("/meta/merchant-types", async (_req, res) => {
  const [rows] = await db.query<RowDataPacket[]>("SELECT id, name FROM merchant_types WHERE is_active ORDER BY sort_order, id");
  res.json({ data: rows });
});

meta.get("/meta/categories", async (_req, res) => {
  const [rows] = await db.query<RowDataPacket[]>("SELECT id, name, slug, icon FROM categories WHERE is_active ORDER BY sort_order, id");
  res.json({ data: rows });
});

meta.get("/meta/pickup-points", async (_req, res) => {
  const [rows] = await db.query<RowDataPacket[]>("SELECT id, name, description FROM pickup_points WHERE is_active ORDER BY name");
  res.json({ data: rows });
});

meta.get("/meta/settings", async (_req, res) => {
  const [rows] = await db.query<RowDataPacket[]>("SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN ('service_fee', 'timezone')");
  const s = Object.fromEntries(rows.map((r) => [r.setting_key, r.setting_value]));
  res.json({ data: { service_fee: Number(s.service_fee), timezone: s.timezone } });
});
