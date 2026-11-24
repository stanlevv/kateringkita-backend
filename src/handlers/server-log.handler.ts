// Isi file: handler HTTP dasbor server di panel admin (GET /admin/server-status dan /admin/server-logs), khusus admin
// super (path berawalan "server-" dijaga middleware/admin-access.ts). Data diambil dari server-log.service.
import { RequestHandler } from "express";
import { serverLogFilterSchema } from "../dto/server-log.dto";
import { parse } from "../middleware/validate";
import { listServerLogs, getServerStatus } from "../services/server-log.service";

/**
 * `GET /admin/server-logs`: daftar log server (galat 5xx dan request lambat) per halaman.
 * @param req permintaan; query diperiksa serverLogFilterSchema
 * @param res jawaban `{ data, meta: { page, limit, total } }`
 * @returns selesai setelah jawaban dikirim
 * @throws 400 query tidak valid
 */
export const listServerLogsHandler: RequestHandler = async (req, res) => {
  res.json(await listServerLogs(parse(serverLogFilterSchema, req.query)));
};

/**
 * `GET /admin/server-status`: kondisi server dan ringkasan log 24 jam terakhir.
 * @param _req permintaan (tidak dibaca)
 * @param res  jawaban `{ data }` berisi uptime, memori, versi Node, kondisi database, dan hitungan per jam
 * @returns selesai setelah jawaban dikirim
 */
export const getServerStatusHandler: RequestHandler = async (_req, res) => {
  res.json({ data: await getServerStatus() });
};
