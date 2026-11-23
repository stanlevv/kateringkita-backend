// Isi file: handler HTTP menu hasil AI di panel admin (GET dan PATCH /admin/hasil-ai). Semua tingkat admin boleh
// melihat; memberi keputusan hanya admin ops dan super (middleware/admin-access.ts). Isi PATCH sudah diperiksa
// verifyAiResultSchema di routes/admin.ts; query daftar diperiksa di sini.
import { RequestHandler } from "express";
import { listAiResultsSchema } from "../dto/ai-result.dto";
import { AuthedRequest } from "../middleware/auth";
import { parse } from "../middleware/validate";
import { listAiResults, verifyAiResult } from "../services/ai-result.service";

/**
 * `GET /admin/hasil-ai`: daftar hasil AI per halaman dengan filter status dan fitur.
 * @param req permintaan; query diperiksa listAiResultsSchema
 * @param res jawaban `{ data, meta: { page, limit, total } }`
 * @returns selesai setelah jawaban dikirim
 * @throws 400 status atau fitur tidak dikenal
 */
export const listAiResultsHandler: RequestHandler = async (req, res) => {
  res.json(await listAiResults(parse(listAiResultsSchema, req.query)));
};

/**
 * `PATCH /admin/hasil-ai/:id`: menyetujui atau menolak satu hasil AI.
 * @param req permintaan dengan `:id`; isi `{ status, catatan }` sudah diperiksa di rute
 * @param res jawaban `{ data }` berisi hasil AI sesudah diperiksa
 * @returns selesai setelah jawaban dikirim
 * @throws 404 hasil AI tidak ditemukan
 */
export const verifyAiResultHandler: RequestHandler = async (req, res) => {
  res.json({ data: await verifyAiResult((req as AuthedRequest).auth.userId, req.params.id, req.body) });
};
