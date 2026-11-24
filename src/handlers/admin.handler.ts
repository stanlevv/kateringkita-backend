// Isi file: handler HTTP panel admin (/api/v1/admin) untuk log audit, penjual, data master, promo platform,
// pengaturan, ringkasan, moderasi, rekap keuangan, pengumuman, dan kelola akun admin. Rute dan penjaganya ada di
// routes/admin.ts; siapa boleh memanggil apa ditentukan middleware/admin-access.ts sebelum handler ini berjalan.
// Handler hanya membaca isi request (id, query, body), memanggil service, lalu mengirim JSON.
import { RequestHandler } from "express";
import { AuthedRequest } from "../middleware/auth";
import { listAuditLogs, parseLogFilter } from "../services/admin-audit.service";
import { createMasterData, listMasterData, setMasterActive, updateMasterData } from "../services/admin-master.service";
import {
  getVerificationQueue,
  listMerchants,
  getMerchantDetail,
  runMerchantAction,
} from "../services/admin-merchant.service";
import {
  getServiceFee,
  getCsContact,
  createPromo,
  listPromos,
  setPromoActive,
  updateServiceFee,
  updateCsContact,
  updatePromo,
} from "../services/admin-promo.service";
import { sendAnnouncement } from "../services/admin-announcement.service";
import { getAdminQueues, getAdminSummary } from "../services/admin-summary.service";
import { getFinanceSummary } from "../services/admin-finance.service";
import { adminRangeSchema } from "../dto/merchant-report.dto";
import { parse } from "../middleware/validate";
import {
  listAdminMenus,
  listAdminReviews,
  removeMenuPhoto,
  moderateMenu,
  moderateReview,
} from "../services/admin-moderation.service";
import {
  createAdmin,
  listAdmins,
  resetAdminPassword,
  setAdminActive,
  updateAdminLevel,
} from "../services/admin-account.service";
import { AppError } from "../utils/errors";
import { getMaintenance, updateMaintenance } from "../services/maintenance.service";

// Angka halaman/batas dari query: dibulatkan ke bawah dan dibatasi `max`; tidak valid atau kurang dari 1 = `fallback`.
const toPositiveInt = (value: unknown, fallback: number, max: number) => {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(parsed, max) : fallback;
};
/**
 * Membaca id penjual dari URL. Id yang bukan bilangan bulat positif dianggap penjual yang tidak ada. Dipakai juga
 * routes/admin.ts untuk memeriksa id sebelum isi permintaan.
 * @param value `req.params.id`
 * @returns id penjual
 * @throws 404 bila id tidak valid
 */
export const parseMerchantId = (value: unknown) => {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw new AppError(404, "NOT_FOUND", "Penjual tidak ditemukan.");
  return id;
};
// Nilai query yang bukan teks (misalnya dikirim dua kali menjadi array) dianggap tidak diisi.
const asString = (value: unknown) => (typeof value === "string" ? value : undefined);
// id admin yang login, sudah dipasang middleware requireAuth.
const getAdminId = (req: unknown) => (req as AuthedRequest).auth.userId;

/**
 * `GET /admin/audit-logs`: daftar log audit admin per halaman (bawaan 20, maks 100), dengan filter opsional.
 * @param req permintaan; query `page`, `limit`, `action`, `target_type`, `target_id`, `admin`, `from`, `to`
 * @param res jawaban `{ data, meta: { page, limit, total } }`
 * @returns selesai setelah jawaban dikirim
 * @throws 400 filter tidak valid
 */
export const listAuditLogsHandler: RequestHandler = async (req, res) => {
  res.json(
    await listAuditLogs(
      parseLogFilter(req.query, toPositiveInt(req.query.page, 1, 1e6), toPositiveInt(req.query.limit, 20, 100)),
    ),
  );
};

/**
 * `GET /admin/merchants`: daftar penjual per halaman dengan pencarian dan filter.
 * @param req permintaan; query `q` (nama usaha atau nomor WA), `status`, `open` (1/0), `page`, `limit`
 * @param res jawaban `{ data, meta: { page, limit, total } }`
 * @returns selesai setelah jawaban dikirim
 * @throws 400 status atau `open` tidak valid
 */
export const listMerchantsHandler: RequestHandler = async (req, res) => {
  const { q: search, status, open } = req.query;
  res.json(
    await listMerchants({
      q: asString(search)?.trim(),
      status: asString(status),
      open: asString(open),
      page: toPositiveInt(req.query.page, 1, 1e6),
      limit: toPositiveInt(req.query.limit, 20, 100),
    }),
  );
};

/**
 * `GET /admin/verification-queue`: antrean toko yang menunggu verifikasi atau sedang diminta perbaikan.
 * @param _req permintaan (tidak dibaca)
 * @param res  jawaban `{ data }` berisi daftar toko beserta checklist
 * @returns selesai setelah jawaban dikirim
 */
export const getVerificationQueueHandler: RequestHandler = async (_req, res) => {
  res.json({ data: await getVerificationQueue() });
};

/**
 * `GET /admin/merchants/:id`: detail satu penjual untuk admin.
 * @param req permintaan dengan `:id` toko
 * @param res jawaban `{ data }` berisi profil, pemilik, titik temu, checklist, dan log terbaru
 * @returns selesai setelah jawaban dikirim
 * @throws 404 id tidak valid atau toko tidak ada
 */
export const getMerchantDetailHandler: RequestHandler = async (req, res) => {
  res.json({ data: await getMerchantDetail(parseMerchantId(req.params.id)) });
};

/**
 * Membuat handler `POST /admin/merchants/:id/<name>`; routes/admin.ts memasang satu rute per nama di ACTION_NAMES.
 * @param name nama aksi, contoh `verify`, `suspend`, `close-today`
 * @returns handler yang menjalankan aksi itu dengan `reason` dari isi permintaan (bila ada) dan menjawab `{ data }`
 *          berisi detail toko sesudah aksi; galatnya 404 toko tidak ada atau 409 status tidak cocok
 */
export const merchantActionHandler =
  (name: string): RequestHandler =>
  async (req, res) => {
    res.json({
      data: await runMerchantAction(getAdminId(req), parseMerchantId(req.params.id), name, req.body?.reason),
    });
  };

// Tipe params sama dengan yang diturunkan Express dari path "/master/:kind" dan "/master/:kind/:id".
/**
 * `GET /admin/master/:kind`: daftar data master satu jenis (kategori, titik temu, atau jenis usaha).
 * @param req permintaan dengan `:kind`
 * @param res jawaban `{ data }`
 * @returns selesai setelah jawaban dikirim
 * @throws 404 jenis tidak dikenal
 */
export const listMasterDataHandler: RequestHandler<{ kind: string }> = async (req, res) => {
  res.json({ data: await listMasterData(req.params.kind) });
};
/**
 * `POST /admin/master/:kind`: menambah data master.
 * @param req permintaan dengan `:kind` dan isi sesuai jenisnya
 * @param res jawaban 201 `{ data }` berisi data baru
 * @returns selesai setelah jawaban dikirim
 * @throws 400 isi tidak valid, 404 jenis tidak dikenal, 409 nama sudah dipakai
 */
export const createMasterDataHandler: RequestHandler<{ kind: string }> = async (req, res) => {
  res.status(201).json({ data: await createMasterData(getAdminId(req), req.params.kind, req.body) });
};
/**
 * `PATCH /admin/master/:kind/:id`: mengubah sebagian kolom data master.
 * @param req permintaan dengan `:kind`, `:id`, dan kolom yang diubah
 * @param res jawaban `{ data }` berisi data sesudah diubah
 * @returns selesai setelah jawaban dikirim
 * @throws 400 isi tidak valid, 404 jenis atau data tidak ada, 409 nama sudah dipakai
 */
export const updateMasterDataHandler: RequestHandler<{ kind: string; id: string }> = async (req, res) => {
  res.json({ data: await updateMasterData(getAdminId(req), req.params.kind, req.params.id, req.body) });
};
/**
 * Membuat handler `POST /admin/master/:kind/:id/activate` (active = true) atau `.../deactivate` (active = false).
 * @param active `true` untuk mengaktifkan, `false` untuk menonaktifkan
 * @returns handler yang menjawab `{ data }` berisi data sesudah diubah; galatnya 404 data tidak ada atau 409 titik
 *          temu terakhir bagi toko terverifikasi
 */
export const setMasterActiveHandler =
  (active: boolean): RequestHandler =>
  async (req, res) => {
    res.json({ data: await setMasterActive(getAdminId(req), String(req.params.kind), req.params.id, active) });
  };

/**
 * `GET /admin/promos`: daftar promo platform.
 * @param _req permintaan (tidak dibaca)
 * @param res  jawaban `{ data }`
 * @returns selesai setelah jawaban dikirim
 */
export const listPromosHandler: RequestHandler = async (_req, res) => {
  res.json({ data: await listPromos() });
};
/**
 * `POST /admin/promos`: membuat promo platform.
 * @param req permintaan; isinya kode dan kolom promo (diperiksa di service)
 * @param res jawaban 201 `{ data }` berisi promo baru
 * @returns selesai setelah jawaban dikirim
 * @throws 400 isian tidak valid, 409 kode sudah dipakai
 */
export const createPromoHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await createPromo(getAdminId(req), req.body) });
};
/**
 * `PATCH /admin/promos/:id`: mengubah sebagian isi promo platform.
 * @param req permintaan dengan `:id` dan kolom yang diubah
 * @param res jawaban `{ data }` berisi promo sesudah diubah
 * @returns selesai setelah jawaban dikirim
 * @throws 400 isian tidak valid, 404 promo tidak ada
 */
export const updatePromoHandler: RequestHandler = async (req, res) => {
  res.json({ data: await updatePromo(getAdminId(req), req.params.id, req.body) });
};
/**
 * Membuat handler `POST /admin/promos/:id/activate` (active = true) atau `.../deactivate` (active = false).
 * @param active `true` untuk menyalakan, `false` untuk mematikan
 * @returns handler yang menjawab `{ data }` berisi promo sesudah diubah; galatnya 404 promo tidak ada
 */
export const setPromoActiveHandler =
  (active: boolean): RequestHandler =>
  async (req, res) => {
    res.json({ data: await setPromoActive(getAdminId(req), req.params.id, active) });
  };
/**
 * `GET /admin/settings`: pengaturan aplikasi yang diatur admin (boleh dibaca semua tingkat admin).
 * @param _req permintaan (tidak dibaca)
 * @param res  jawaban `{ data: { service_fee, cs_whatsapp, maintenance } }`
 * @returns selesai setelah jawaban dikirim
 */
export const getSettingsHandler: RequestHandler = async (_req, res) => {
  res.json({
    data: {
      service_fee: await getServiceFee(),
      cs_whatsapp: await getCsContact(),
      maintenance: await getMaintenance(),
    },
  });
};
/**
 * `PUT /admin/settings/maintenance`: menyalakan atau mematikan mode pemeliharaan (khusus admin super).
 * @param req permintaan; isinya sudah diperiksa maintenanceSchema di rute
 * @param res jawaban `{ data: { maintenance } }`
 * @returns selesai setelah jawaban dikirim
 */
export const updateMaintenanceHandler: RequestHandler = async (req, res) => {
  res.json({ data: { maintenance: await updateMaintenance(getAdminId(req), req.body) } });
};
/**
 * `PUT /admin/settings/service-fee`: mengubah biaya layanan (khusus admin super).
 * @param req permintaan; isi `{ value }` diperiksa di service
 * @param res jawaban `{ data: { service_fee } }`
 * @returns selesai setelah jawaban dikirim
 * @throws 400 nilai tidak valid
 */
export const updateServiceFeeHandler: RequestHandler = async (req, res) => {
  res.json({ data: await updateServiceFee(getAdminId(req), req.body) });
};
/**
 * `GET /admin/summary`: ringkasan beranda panel admin.
 * @param _req permintaan (tidak dibaca)
 * @param res  jawaban `{ data }` berisi pesanan dan omzet hari ini, jumlah toko, dan log terbaru
 * @returns selesai setelah jawaban dikirim
 */
export const getSummaryHandler: RequestHandler = async (_req, res) => {
  res.json({ data: await getAdminSummary() });
};
/**
 * `GET /admin/queues`: hitungan antrean "Perlu tindakan" untuk dashboard dan lencana menu admin.
 * @param req permintaan; tingkat admin dibaca dari token
 * @param res jawaban `{ data }` berisi enam hitungan; dua hitungan uang `null` bila admin bukan super
 * @returns selesai setelah jawaban dikirim
 */
export const getQueuesHandler: RequestHandler = async (req, res) => {
  res.json({ data: await getAdminQueues((req as AuthedRequest).auth.adminLevel) });
};

// Filter daftar moderasi dari query: ?q=&status=active|moderated&page&limit (halaman bawaan 20, maks 100).
const parseModerationFilter = (query: Record<string, unknown>) => ({
  q: asString(query.q)?.trim() || undefined,
  status: asString(query.status),
  page: toPositiveInt(query.page, 1, 1e6),
  limit: toPositiveInt(query.limit, 20, 100),
});
/**
 * `GET /admin/reviews`: daftar ulasan untuk moderasi.
 * @param req permintaan; query `q`, `status`, `page`, `limit`
 * @param res jawaban `{ data, meta }`
 * @returns selesai setelah jawaban dikirim
 * @throws 400 status tidak valid
 */
export const listAdminReviewsHandler: RequestHandler = async (req, res) => {
  res.json(await listAdminReviews(parseModerationFilter(req.query)));
};
/**
 * Membuat handler `POST /admin/reviews/:id/hide` (hide = true; alasan wajib, diperiksa adminReasonSchema di rute)
 * atau `.../unhide` (hide = false; alasan diabaikan).
 * @param hide `true` untuk menyembunyikan, `false` untuk menampilkan lagi
 * @returns handler yang menjawab `{ data }` berisi ulasan sesudah diubah; galatnya 404 ulasan tidak ada
 */
export const moderateReviewHandler =
  (hide: boolean): RequestHandler =>
  async (req, res) => {
    res.json({ data: await moderateReview(getAdminId(req), req.params.id, hide, hide ? req.body.reason : null) });
  };
/**
 * `GET /admin/menus`: daftar menu untuk moderasi.
 * @param req permintaan; query `q`, `status`, `page`, `limit`
 * @param res jawaban `{ data, meta }`
 * @returns selesai setelah jawaban dikirim
 * @throws 400 status tidak valid
 */
export const listAdminMenusHandler: RequestHandler = async (req, res) => {
  res.json(await listAdminMenus(parseModerationFilter(req.query)));
};
/**
 * Membuat handler `POST /admin/menus/:id/takedown` (takedown = true; alasan wajib, diperiksa di rute) atau
 * `.../restore` (takedown = false; alasan diabaikan).
 * @param takedown `true` untuk menurunkan, `false` untuk memulihkan
 * @returns handler yang menjawab `{ data }` berisi menu sesudah diubah; galatnya 404 menu tidak ada
 */
export const moderateMenuHandler =
  (takedown: boolean): RequestHandler =>
  async (req, res) => {
    res.json({ data: await moderateMenu(getAdminId(req), req.params.id, takedown, takedown ? req.body.reason : null) });
  };
/**
 * `POST /admin/menus/:id/photos/remove`: menghapus satu foto menu.
 * @param req permintaan dengan `:id`; isi `{ url, reason }` sudah diperiksa removePhotoSchema di rute
 * @param res jawaban `{ data }` berisi menu sesudah foto dihapus
 * @returns selesai setelah jawaban dikirim
 * @throws 404 menu atau foto tidak ditemukan
 */
export const removeMenuPhotoHandler: RequestHandler = async (req, res) => {
  res.json({ data: await removeMenuPhoto(getAdminId(req), req.params.id, req.body.url, req.body.reason) });
};

/**
 * `GET /admin/finance?from&to`: rekap keuangan per toko (khusus admin super).
 * @param req permintaan; query `from` dan `to` tanggal WIB, paling panjang 92 hari (adminRangeSchema)
 * @param res jawaban `{ data: { rows, totals } }`
 * @returns selesai setelah jawaban dikirim
 * @throws 400 rentang tanggal tidak valid
 */
export const getFinanceSummaryHandler: RequestHandler = async (req, res) => {
  res.json({ data: await getFinanceSummary(parse(adminRangeSchema, req.query)) });
};

/**
 * `PUT /admin/settings/cs-contact`: mengubah nomor WhatsApp CS (khusus admin super).
 * @param req permintaan; isi `{ wa_number }` sudah diperiksa csContactSchema di rute
 * @param res jawaban `{ data: { cs_whatsapp } }`
 * @returns selesai setelah jawaban dikirim
 */
export const updateCsContactHandler: RequestHandler = async (req, res) => {
  res.json({ data: await updateCsContact(getAdminId(req), req.body.wa_number) });
};
/**
 * `POST /admin/broadcasts`: mengirim pengumuman ke pengguna.
 * @param req permintaan; isi sudah diperiksa announcementSchema di rute
 * @param res jawaban 201 `{ data: { sent } }`
 * @returns selesai setelah jawaban dikirim
 */
export const sendAnnouncementHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await sendAnnouncement(getAdminId(req), req.body) });
};

// Kelola akun admin: semua rute /admin/admins khusus admin super (dijaga middleware adminAccess).
/**
 * `GET /admin/admins`: daftar akun admin.
 * @param _req permintaan (tidak dibaca)
 * @param res  jawaban `{ data }`
 * @returns selesai setelah jawaban dikirim
 */
export const listAdminsHandler: RequestHandler = async (_req, res) => {
  res.json({ data: await listAdmins() });
};
/**
 * `POST /admin/admins`: membuat akun admin baru dengan sandi sementara.
 * @param req permintaan; isi sudah diperiksa createAdminSchema di rute
 * @param res jawaban 201 `{ data: { admin, temp_password } }`
 * @returns selesai setelah jawaban dikirim
 * @throws 409 nomor HP sudah terdaftar
 */
export const createAdminHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await createAdmin(getAdminId(req), req.body) });
};
/**
 * `PATCH /admin/admins/:id/level`: mengubah tingkat admin lain.
 * @param req permintaan dengan `:id`; isi `{ admin_level }` sudah diperiksa di rute
 * @param res jawaban `{ data }` berisi akun sesudah diubah
 * @returns selesai setelah jawaban dikirim
 * @throws 404 admin tidak ada, 409 akun sendiri atau super aktif terakhir
 */
export const updateAdminLevelHandler: RequestHandler = async (req, res) => {
  res.json({ data: await updateAdminLevel(getAdminId(req), req.params.id, req.body.admin_level) });
};
/**
 * Membuat handler `POST /admin/admins/:id/activate` (active = true) atau `.../deactivate` (active = false).
 * @param active `true` untuk mengaktifkan, `false` untuk menonaktifkan
 * @returns handler yang menjawab `{ data }` berisi akun sesudah diubah; galatnya 404 admin tidak ada, 409 akun sendiri
 *          atau super aktif terakhir
 */
export const setAdminActiveHandler =
  (active: boolean): RequestHandler =>
  async (req, res) => {
    res.json({ data: await setAdminActive(getAdminId(req), req.params.id, active) });
  };
/**
 * `POST /admin/admins/:id/reset-password`: mereset sandi admin lain menjadi sandi sementara baru.
 * @param req permintaan dengan `:id`
 * @param res jawaban `{ data: { admin, temp_password } }`
 * @returns selesai setelah jawaban dikirim
 * @throws 404 admin tidak ada, 409 akun sendiri
 */
export const resetAdminPasswordHandler: RequestHandler = async (req, res) => {
  res.json({ data: await resetAdminPassword(getAdminId(req), req.params.id) });
};
