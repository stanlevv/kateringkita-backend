import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();

const isTiDB =
  (process.env.DB_HOST || "").includes("tidbcloud.com") ||
  (process.env.DATABASE_URL || "").includes("tidbcloud.com") ||
  process.env.DB_SSL === "true";

const pool = process.env.DATABASE_URL
  ? mysql.createPool({
      uri: process.env.DATABASE_URL,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      ssl: isTiDB ? { rejectUnauthorized: true, minVersion: "TLSv1.2" } : undefined,
    })
  : mysql.createPool({
      host: process.env.DB_HOST || "localhost",
      port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
      user: process.env.DB_USER || "root",
      password: process.env.DB_PASS || "",
      database: process.env.DB_NAME || "test",
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      ssl: isTiDB ? { rejectUnauthorized: true, minVersion: "TLSv1.2" } : undefined,
    });

export default pool;
