import { RequestHandler } from "express";
import { daftarHasilAiSchema } from "../dto/ai-result.dto";
import { AuthedRequest } from "../middleware/auth";
import { parse } from "../middleware/validate";
import { daftarHasilAi, verifikasiHasilAi } from "../services/ai-result.service";

// Rubrik AI: verifikasi manual hasil AI (admin). Body PATCH sudah divalidasi skema di rute.
export const daftarHasilAiHandler: RequestHandler = async (req, res) => {
  res.json(await daftarHasilAi(parse(daftarHasilAiSchema, req.query)));
};

export const verifikasiHasilAiHandler: RequestHandler = async (req, res) => {
  res.json({ data: await verifikasiHasilAi((req as AuthedRequest).auth.userId, req.params.id, req.body) });
};
