import { RequestHandler } from "express";
import { getSettings, listMerchantTypes, listCategories, listPickupPoints } from "../services/meta.service";

export const listMerchantTypesHandler: RequestHandler = async (_req, res) => {
  res.json({ data: await listMerchantTypes() });
};

export const listCategoriesHandler: RequestHandler = async (_req, res) => {
  res.json({ data: await listCategories() });
};

export const listPickupPointsHandler: RequestHandler = async (_req, res) => {
  res.json({ data: await listPickupPoints() });
};

export const getSettingsHandler: RequestHandler = async (_req, res) => {
  res.json({ data: await getSettings() });
};
