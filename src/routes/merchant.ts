import { Router } from "express";
import { menuPatchSchema, menuSchema } from "../dto/merchant-menu.dto";
import { statusSchema, updateProfileSchema } from "../dto/merchant.dto";
import { merchantUploadSchema } from "../dto/upload.dto";
import {
  aksiPesananTokoHandler, ambilMenuHandler, ambilPesananTokoHandler, buatMenuHandler, daftarMenuHandler, daftarPesananTokoHandler,
  getProfileHandler, hapusMenuHandler, laporanPerJamHandler, laporanTransaksiHandler, ringkasanLaporanHandler, setOpenHandler, ubahKuotaHandler, ubahMenuHandler, updateProfileHandler, uploadFotoHandler,
  waPesananTokoHandler,
} from "../handlers/merchant.handler";
import { uploadLimiter } from "../middleware/rateLimiter";
import { validate } from "../middleware/validate";

// Penjaga (requireAuth + requireRole("merchant")) dipasang sekali di app.ts; toko selalu dari token (R-10).
export const merchant = Router();

merchant.get("/profile", getProfileHandler);

merchant.patch("/status", validate(statusSchema), setOpenHandler);

merchant.patch("/profile", validate(updateProfileSchema), updateProfileHandler);

merchant.get("/menus", daftarMenuHandler);

merchant.get("/menus/:id", ambilMenuHandler);

merchant.post("/menus", validate(menuSchema), buatMenuHandler);

merchant.patch("/menus/:id", validate(menuPatchSchema), ubahMenuHandler);

merchant.delete("/menus/:id", hapusMenuHandler);

merchant.patch("/menus/:id/quota", ubahKuotaHandler);

merchant.post("/uploads", validate(merchantUploadSchema), uploadLimiter, uploadFotoHandler);

// F07 (M-04): daftar & detail pesanan toko
merchant.get("/orders", daftarPesananTokoHandler);

merchant.get("/orders/:code", ambilPesananTokoHandler);

// F07 (M-04, M-11): tautan chat ke pembeli
merchant.get("/orders/:code/whatsapp", waPesananTokoHandler);

// F09 laporan penjualan
merchant.get("/reports/summary", ringkasanLaporanHandler);

merchant.get("/reports/hourly", laporanPerJamHandler);

merchant.get("/reports/transactions", laporanTransaksiHandler);

// F07 (M-04, M-08), F10 (pay): aksi di luar AKSI_TOKO → lanjut ke notFoundHandler (404)
merchant.post("/orders/:code/:aksi", aksiPesananTokoHandler);
