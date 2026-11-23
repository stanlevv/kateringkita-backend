import { Request, RequestHandler } from "express";
import { listNotificationsSchema, markAsReadSchema } from "../dto/notification.dto";
import { bodyObject } from "../dto/order.dto";
import { AuthedRequest } from "../middleware/auth";
import { parse } from "../middleware/validate";
import { listNotifications, markAsRead } from "../services/notification.service";

const getUserId = (req: Request) => (req as AuthedRequest).auth.userId;

export const listNotificationsHandler: RequestHandler = async (req, res) => {
  res.json(await listNotifications(getUserId(req), parse(listNotificationsSchema, req.query)));
};

export const markAsReadHandler: RequestHandler = async (req, res) => {
  res.json({ data: await markAsRead(getUserId(req), parse(markAsReadSchema, bodyObject(req.body))) });
};
