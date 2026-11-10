import { Router } from "express";
import { menuPatchSchema, menuSchema } from "../dto/merchant-menu.dto";
import { statusSchema, updateProfileSchema } from "../dto/merchant.dto";
import { merchantUploadSchema } from "../dto/upload.dto";
import { tanyaSchema } from "../dto/asisten.dto";
import { mejaSchema, ubahMejaSchema } from "../dto/meja.dto";
import { rekeningSchema } from "../dto/pencairan.dto";
import { buatMejaHandler, daftarMejaHandler, ubahMejaHandler } from "../handlers/meja.handler";
import { pencairanSayaHandler, ubahRekeningHandler } from "../handlers/pencairan.handler";
import {
  aksiPesananTokoHandler, ambilMenuHandler, ambilPesananTokoHandler, buatMenuHandler, daftarMenuHandler, daftarPesananTokoHandler,
  buatPromoTokoHandler, daftarPromoTokoHandler, daftarUlasanTokoHandler, hapusPromoTokoHandler, tanyaAsistenHandler, ubahPromoTokoHandler,
  getProfileHandler, hapusMenuHandler, laporanPerJamHandler, laporanTransaksiHandler, ringkasanLaporanHandler, setOpenHandler, ubahKuotaHandler, ubahMenuHandler, updateProfileHandler, uploadFotoHandler,
  waPesananTokoHandler,
} from "../handlers/merchant.handler";
import { asistenLimiter, passwordLimiter, uploadLimiter } from "../middleware/rateLimiter";
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

// F12 promo toko
merchant.get("/promos", daftarPromoTokoHandler);

merchant.post("/promos", buatPromoTokoHandler);

merchant.patch("/promos/:id", ubahPromoTokoHandler);

merchant.delete("/promos/:id", hapusPromoTokoHandler);

// F13 ulasan pembeli untuk menu toko
merchant.get("/reviews", daftarUlasanTokoHandler);

// F17 asisten AI toko
merchant.post("/assistant", validate(tanyaSchema), asistenLimiter, tanyaAsistenHandler);

// F21: meja & QR pesan dari meja
merchant.get("/tables", daftarMejaHandler);
merchant.post("/tables", validate(mejaSchema), buatMejaHandler);
merchant.patch("/tables/:id", validate(ubahMejaSchema), ubahMejaHandler);

// F26: rekening pencairan (kata sandi diminta ulang, salah 5×/menit → 429), saldo & riwayat pencairan
merchant.get("/payouts", pencairanSayaHandler);
merchant.put("/payout-account", validate(rekeningSchema), passwordLimiter, ubahRekeningHandler);

// F07 (M-04, M-08): aksi di luar AKSI_TOKO → lanjut ke notFoundHandler (404)

merchant.post("/orders/:code/:aksi", aksiPesananTokoHandler);
