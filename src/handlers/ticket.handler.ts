import { Request, RequestHandler } from "express";
import { bodyObject } from "../dto/order.dto";
import { replyTicketSchema, createTicketSchema, listAdminTicketsSchema, listTicketsSchema } from "../dto/ticket.dto";
import { AuthedRequest } from "../middleware/auth";
import { parse } from "../middleware/validate";
import { balasTiketAdmin, daftarTiketAdmin, detailTiketAdmin, tutupTiketAdmin } from "../services/admin-tiket.service";
import { getMyTicket, replyMyTicket, createTicket, listMyTickets, closeMyTicket } from "../services/ticket.service";

// Tiket bantuan (CS). Body bukan objek (kosong, teks) dianggap {} agar galat tetap per field.
const getUserId = (req: Request) => (req as AuthedRequest).auth.userId;
const getTicketCode = (req: Request) => String(req.params.code);
const getReplyBody = (req: Request) => parse(replyTicketSchema, bodyObject(req.body)).body;

export const createTicketHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await createTicket(getUserId(req), parse(createTicketSchema, bodyObject(req.body))) });
};

export const listMyTicketsHandler: RequestHandler = async (req, res) => {
  res.json(await listMyTickets(getUserId(req), parse(listTicketsSchema, req.query)));
};

export const getMyTicketHandler: RequestHandler = async (req, res) => {
  res.json({ data: await getMyTicket(getUserId(req), getTicketCode(req)) });
};

export const replyMyTicketHandler: RequestHandler = async (req, res) => {
  const body = getReplyBody(req);
  res.status(201).json({ data: await replyMyTicket(getUserId(req), getTicketCode(req), body) });
};

export const closeMyTicketHandler: RequestHandler = async (req, res) => {
  res.json({ data: await closeMyTicket(getUserId(req), getTicketCode(req)) });
};

// Admin (/admin/tickets); semua tingkat admin
export const listAdminTicketsHandler: RequestHandler = async (req, res) => {
  res.json(await daftarTiketAdmin(parse(listAdminTicketsSchema, req.query)));
};

export const getAdminTicketHandler: RequestHandler = async (req, res) => {
  res.json({ data: await detailTiketAdmin(getTicketCode(req)) });
};

export const replyAdminTicketHandler: RequestHandler = async (req, res) => {
  const body = getReplyBody(req);
  res.status(201).json({ data: await balasTiketAdmin(getUserId(req), getTicketCode(req), body) });
};

export const closeAdminTicketHandler: RequestHandler = async (req, res) => {
  res.json({ data: await tutupTiketAdmin(getUserId(req), getTicketCode(req)) });
};
