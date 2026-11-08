import { Router } from "express";
import { daftarJenisUsahaHandler, daftarKategoriHandler, daftarTitikTemuHandler, pengaturanHandler } from "../handlers/meta.handler";

export const meta = Router();

meta.get("/meta/merchant-types", daftarJenisUsahaHandler);

meta.get("/meta/categories", daftarKategoriHandler);

meta.get("/meta/pickup-points", daftarTitikTemuHandler);

meta.get("/meta/settings", pengaturanHandler);
