import { Router } from "express";
import {
  listMerchantTypesHandler,
  listCategoriesHandler,
  listPickupPointsHandler,
  getSettingsHandler,
} from "../handlers/meta.handler";

export const meta = Router();

meta.get("/meta/merchant-types", listMerchantTypesHandler);

meta.get("/meta/categories", listCategoriesHandler);

meta.get("/meta/pickup-points", listPickupPointsHandler);

meta.get("/meta/settings", getSettingsHandler);
