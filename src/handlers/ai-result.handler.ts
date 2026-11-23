import { RequestHandler } from "express";
import { listAiResultsSchema } from "../dto/ai-result.dto";
import { AuthedRequest } from "../middleware/auth";
import { parse } from "../middleware/validate";
import { listAiResults, verifyAiResult } from "../services/ai-result.service";

// Rubrik AI: verifikasi manual hasil AI (admin). Body PATCH sudah divalidasi skema di rute.
export const listAiResultsHandler: RequestHandler = async (req, res) => {
  res.json(await listAiResults(parse(listAiResultsSchema, req.query)));
};

export const verifyAiResultHandler: RequestHandler = async (req, res) => {
  res.json({ data: await verifyAiResult((req as AuthedRequest).auth.userId, req.params.id, req.body) });
};
