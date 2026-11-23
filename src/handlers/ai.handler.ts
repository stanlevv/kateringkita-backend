// Isi file: handler HTTP menu AI gateway di panel admin: kelola penyedia AI, uji koneksi, dan dasbor pemakaian
// (/admin/ai-providers, /admin/ai-usage). Semua rute ini khusus admin super (path berawalan "ai-" dijaga
// middleware/admin-access.ts). Isi permintaan sudah diperiksa skema dto/ai.dto.ts di routes/admin.ts.
import { Request, RequestHandler } from "express";
import { aiUsageSchema } from "../dto/ai.dto";
import { AuthedRequest } from "../middleware/auth";
import { parse } from "../middleware/validate";
import {
  createAiProvider,
  listAiProviders,
  deleteAiProvider,
  getAiUsage,
  updateAiProvider,
  testAiProvider,
} from "../services/ai.service";

// id admin yang login, sudah dipasang middleware requireAuth.
const getAdminId = (req: Request) => (req as AuthedRequest).auth.userId;

/**
 * `GET /admin/ai-providers`: daftar penyedia AI dan keterangan cadangan env.
 * @param _req permintaan (tidak dibaca)
 * @param res  jawaban `{ data: { providers, env_gemini } }`
 * @returns selesai setelah jawaban dikirim
 */
export const listAiProvidersHandler: RequestHandler = async (_req, res) => {
  res.json({ data: await listAiProviders() });
};

/**
 * `POST /admin/ai-providers`: menambah penyedia AI.
 * @param req permintaan; isi sudah diperiksa aiProviderSchema di rute
 * @param res jawaban 201 `{ data }` berisi penyedia baru (tanpa API key)
 * @returns selesai setelah jawaban dikirim
 */
export const createAiProviderHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await createAiProvider(getAdminId(req), req.body) });
};

/**
 * `PATCH /admin/ai-providers/:id`: mengubah sebagian isi penyedia AI.
 * @param req permintaan dengan `:id`; isi sudah diperiksa updateAiProviderSchema di rute
 * @param res jawaban `{ data }` berisi penyedia sesudah diubah
 * @returns selesai setelah jawaban dikirim
 * @throws 404 penyedia tidak ditemukan
 */
export const updateAiProviderHandler: RequestHandler = async (req, res) => {
  res.json({ data: await updateAiProvider(getAdminId(req), req.params.id, req.body) });
};

/**
 * `DELETE /admin/ai-providers/:id`: menghapus penyedia AI.
 * @param req permintaan dengan `:id`
 * @param res jawaban 204 tanpa isi
 * @returns selesai setelah jawaban dikirim
 * @throws 404 penyedia tidak ditemukan
 */
export const deleteAiProviderHandler: RequestHandler = async (req, res) => {
  await deleteAiProvider(getAdminId(req), req.params.id);
  res.status(204).end();
};

/**
 * `POST /admin/ai-providers/:id/test`: menguji koneksi satu penyedia.
 * @param req permintaan dengan `:id`
 * @param res jawaban `{ data: { ok, ms, sample } }` bila berhasil atau `{ data: { ok: false, message } }` bila gagal
 * @returns selesai setelah jawaban dikirim
 * @throws 404 penyedia tidak ditemukan
 */
export const testAiProviderHandler: RequestHandler = async (req, res) => {
  res.json({ data: await testAiProvider(req.params.id) });
};

/**
 * `GET /admin/ai-usage?days=`: dasbor pemakaian AI (token, panggilan, gagal, latensi) selama 1–90 hari terakhir
 * (bawaan 7).
 * @param req permintaan; query `days`
 * @param res jawaban `{ data }` berisi ringkasan, per penyedia, per fitur, per hari, dan gagal terakhir
 * @returns selesai setelah jawaban dikirim
 */
export const getAiUsageHandler: RequestHandler = async (req, res) => {
  res.json({ data: await getAiUsage(parse(aiUsageSchema, req.query).days) });
};
