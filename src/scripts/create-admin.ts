import "dotenv/config"; // harus pertama: env.ts (lewat db.ts) membaca process.env saat diimpor
import { z } from "zod";
import db from "../config/db";
import { fullName, password, phone } from "../dto/auth.dto";
import { insertUser } from "../services/auth.service";

const adminSchema = z.object({ fullName, phone, password });

export async function createAdmin(input: { phone: string; fullName: string; password: string }): Promise<{ id: number }> {
  const parsed = adminSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  try {
    const user = await insertUser(db, "admin", { full_name: parsed.data.fullName, phone: parsed.data.phone, password: parsed.data.password });
    return { id: user.id };
  } catch (err) {
    if ((err as { code?: string }).code === "ER_DUP_ENTRY") throw new Error("Nomor sudah terdaftar.");
    throw err;
  }
}

const opsi = (argv: string[], nama: string) => {
  const i = argv.indexOf(nama);
  return i >= 0 ? argv[i + 1] : undefined;
};

// Mengembalikan kode keluar proses. Sandi hanya dari env dan tidak pernah dicetak.
export async function jalankan(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const password = env.ADMIN_INITIAL_PASSWORD;
  if (!password) {
    console.error("ADMIN_INITIAL_PASSWORD belum diisi.");
    return 1;
  }
  const phone = opsi(argv, "--phone");
  const name = opsi(argv, "--name");
  if (!phone || !name) {
    console.error('Pemakaian: npm run admin:create -- --phone 08xxxxxxxxxx --name "Nama Admin"');
    return 1;
  }
  try {
    const { id } = await createAdmin({ phone, fullName: name, password });
    console.log(`Admin dibuat (id ${id}).`);
    return 0;
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
}

if (require.main === module) {
  jalankan(process.argv.slice(2), process.env)
    .then((code) => db.end().then(() => process.exit(code)))
    .catch((err) => {
      console.error((err as Error).message);
      process.exit(1);
    });
}
