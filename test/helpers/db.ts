import mysql from "mysql2/promise";

// Kosongkan DB uji yang ditunjuk DATABASE_URL (diisi vitest.config.ts dari TEST_DATABASE_URL).
export async function resetTestDatabase(): Promise<string> {
  const url = new URL(process.env.DATABASE_URL!);
  const name = url.pathname.slice(1);
  if (!name.endsWith("_test")) throw new Error(`Menolak mengosongkan DB "${name}": nama DB uji harus berakhiran _test`);
  url.pathname = "/";
  const conn = await mysql.createConnection(url.toString()).catch((e: Error) => {
    throw new Error(`DB uji tidak bisa dihubungi (${url.host}). Jalankan MySQL lokal atau isi TEST_DATABASE_URL. ${e.message}`);
  });
  await conn.query(`DROP DATABASE IF EXISTS \`${name}\``);
  await conn.query(`CREATE DATABASE \`${name}\``);
  await conn.end();
  return process.env.DATABASE_URL!;
}
