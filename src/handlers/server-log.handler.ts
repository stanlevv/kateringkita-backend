import { RequestHandler } from "express";
import { serverLogFilterSchema } from "../dto/server-log.dto";
import { parse } from "../middleware/validate";
import { listServerLogs, getServerStatus } from "../services/server-log.service";

// F23 dashboard server (admin)
export const listServerLogsHandler: RequestHandler = async (req, res) => {
  res.json(await listServerLogs(parse(serverLogFilterSchema, req.query)));
};

export const getServerStatusHandler: RequestHandler = async (_req, res) => {
  res.json({ data: await getServerStatus() });
};
