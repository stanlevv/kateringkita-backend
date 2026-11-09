import { RequestHandler } from "express";
import { filterLogServerSchema } from "../dto/log-server.dto";
import { parse } from "../middleware/validate";
import { daftarLogServer, statusServer } from "../services/log-server.service";

// F23 dashboard server (admin)
export const daftarLogServerHandler: RequestHandler = async (req, res) => {
  res.json(await daftarLogServer(parse(filterLogServerSchema, req.query)));
};

export const statusServerHandler: RequestHandler = async (_req, res) => {
  res.json({ data: await statusServer() });
};
