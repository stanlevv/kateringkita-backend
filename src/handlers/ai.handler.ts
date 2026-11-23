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

// F22 AI gateway (admin). Body sudah divalidasi skema di rute.
const getAdminId = (req: Request) => (req as AuthedRequest).auth.userId;

export const listAiProvidersHandler: RequestHandler = async (_req, res) => {
  res.json({ data: await listAiProviders() });
};

export const createAiProviderHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await createAiProvider(getAdminId(req), req.body) });
};

export const updateAiProviderHandler: RequestHandler = async (req, res) => {
  res.json({ data: await updateAiProvider(getAdminId(req), req.params.id, req.body) });
};

export const deleteAiProviderHandler: RequestHandler = async (req, res) => {
  await deleteAiProvider(getAdminId(req), req.params.id);
  res.status(204).end();
};

export const testAiProviderHandler: RequestHandler = async (req, res) => {
  res.json({ data: await testAiProvider(req.params.id) });
};

// F25 pemakaian AI: ?days=1..90 (bawaan 7)
export const getAiUsageHandler: RequestHandler = async (req, res) => {
  res.json({ data: await getAiUsage(parse(aiUsageSchema, req.query).days) });
};
