import { Router } from "express";
import { AuthedRequest } from "../auth/middleware";
import { uploadLimiter } from "../auth/rateLimit";
import { AppError } from "../http/errors";
import { fieldsDari, parse, validate } from "../http/validate";
import { buatUnggahan, merchantUploadSchema } from "../upload/service";
import { daftarTokoSchema } from "./orderSchemas";
import { AKSI_TOKO, AksiToko, aksiPesananToko, ambilPesananToko, daftarPesananToko, waPesananToko } from "./orders";
import { laporan } from "../laporan/routes";
import { kuotaSchema, menuPatchSchema, menuQuerySchema, menuSchema } from "./menuSchemas";
import { ambilMenu, buatMenu, daftarMenu, hapusMenu, idToko, ubahKuota, ubahMenu } from "./menus";
import { statusSchema, updateProfileSchema } from "./schemas";
import { getProfile, setOpen, updateProfile } from "./service";

// Penjaga (requireAuth + requireRole("merchant")) dipasang sekali di app.ts; toko selalu dari token (R-10).
export const merchant = Router();
const uid = (req: unknown) => (req as AuthedRequest).auth.userId;

merchant.get("/profile", async (req, res) => {
  res.json({ data: await getProfile(uid(req)) });
});

merchant.patch("/status", validate(statusSchema), async (req, res) => {
  res.json({ data: await setOpen(uid(req), req.body.is_open) });
});

merchant.patch("/profile", validate(updateProfileSchema), async (req, res) => {
  res.json({ data: await updateProfile(uid(req), req.body) });
});

merchant.get("/menus", async (req, res) => {
  res.json({ data: await daftarMenu(uid(req), parse(menuQuerySchema, req.query)) });
});

merchant.get("/menus/:id", async (req, res) => {
  res.json({ data: await ambilMenu(uid(req), req.params.id) });
});

merchant.post("/menus", validate(menuSchema), async (req, res) => {
  res.status(201).json({ data: await buatMenu(uid(req), req.body) });
});

merchant.patch("/menus/:id", validate(menuPatchSchema), async (req, res) => {
  res.json({ data: await ubahMenu(uid(req), req.params.id, req.body) });
});

merchant.delete("/menus/:id", async (req, res) => {
  await hapusMenu(uid(req), req.params.id);
  res.status(204).end();
});

merchant.patch("/menus/:id/quota", async (req, res) => {
  const r = kuotaSchema.safeParse(req.body);
  if (!r.success) {
    // galat lintas-field (path kosong) tidak punya field; galat per field tetap di fields
    const fields = fieldsDari(r.error.issues.filter((i) => i.path.length > 0));
    throw new AppError(400, "VALIDATION_ERROR", "Data kuota tidak valid.", Object.keys(fields).length ? fields : undefined);
  }
  res.json({ data: await ubahKuota(uid(req), req.params.id, r.data) });
});

merchant.post("/uploads", validate(merchantUploadSchema), uploadLimiter, async (req, res) => {
  const { purpose, ...file } = req.body;
  res.json({ data: buatUnggahan(`merchants/${await idToko(uid(req))}/${purpose}/`, file) });
});

// F07 (M-04): daftar & detail pesanan toko
merchant.get("/orders", async (req, res) => {
  res.json(await daftarPesananToko(uid(req), parse(daftarTokoSchema, req.query)));
});

merchant.get("/orders/:code", async (req, res) => {
  res.json({ data: await ambilPesananToko(uid(req), String(req.params.code)) });
});

// F07 (M-04, M-11): tautan chat ke pembeli
merchant.get("/orders/:code/whatsapp", async (req, res) => {
  res.json({ data: await waPesananToko(uid(req), String(req.params.code)) });
});

// F07 (M-04, M-08): aksi di luar 5 → lanjut ke notFoundHandler (404)
merchant.post("/orders/:code/:aksi", async (req, res, next) => {
  const aksi = String(req.params.aksi) as AksiToko;
  if (!AKSI_TOKO.includes(aksi)) return next();
  res.json({ data: await aksiPesananToko(uid(req), String(req.params.code), aksi, req.body) });
});

// F09 (M-09): modul laporan
merchant.use("/reports", laporan);
