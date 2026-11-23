import { Request, RequestHandler } from "express";
import { AuthedRequest } from "../middleware/auth";
import { parse } from "../middleware/validate";
import { pageSchema } from "../dto/payout.dto";
import {
  recordPayout,
  listRefunds,
  listBalances,
  getMyPayouts,
  listPayoutHistory,
  markRefunded,
  updateBankAccount,
} from "../services/payout.service";

// F26 pencairan dana; body sudah divalidasi di rute
const getUserId = (req: Request) => (req as AuthedRequest).auth.userId;

export const getMyPayoutsHandler: RequestHandler = async (req, res) => {
  res.json({ data: await getMyPayouts(getUserId(req)) });
};
export const updateBankAccountHandler: RequestHandler = async (req, res) => {
  res.json({ data: await updateBankAccount(getUserId(req), req.body) });
};

export const listBalancesHandler: RequestHandler = async (_req, res) => {
  res.json({ data: await listBalances() });
};
export const recordPayoutHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await recordPayout(getUserId(req), req.body) });
};
export const listPayoutHistoryHandler: RequestHandler = async (req, res) => {
  res.json(await listPayoutHistory(parse(pageSchema, req.query).page));
};
export const listRefundsHandler: RequestHandler = async (_req, res) => {
  res.json({ data: await listRefunds() });
};
export const markRefundedHandler: RequestHandler = async (req, res) => {
  res.json({ data: await markRefunded(getUserId(req), String(req.params.code), req.body) });
};
