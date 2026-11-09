import { Request, RequestHandler } from "express";
import { AuthedRequest } from "../middleware/auth";
import { buatAi, daftarAi, hapusAi, ubahAi, ujiAi } from "../services/ai.service";

// F22 AI gateway (admin). Body sudah divalidasi skema di rute.
const adminId = (req: Request) => (req as AuthedRequest).auth.userId;

export const daftarAiHandler: RequestHandler = async (_req, res) => {
  res.json({ data: await daftarAi() });
};

export const buatAiHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await buatAi(adminId(req), req.body) });
};

export const ubahAiHandler: RequestHandler = async (req, res) => {
  res.json({ data: await ubahAi(adminId(req), req.params.id, req.body) });
};

export const hapusAiHandler: RequestHandler = async (req, res) => {
  await hapusAi(adminId(req), req.params.id);
  res.status(204).end();
};

export const ujiAiHandler: RequestHandler = async (req, res) => {
  res.json({ data: await ujiAi(req.params.id) });
};
