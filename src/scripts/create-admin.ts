import "dotenv/config"; // harus pertama: env.ts (lewat db.ts) membaca process.env saat diimpor
import { z } from "zod";
import db from "../config/db";
import { fullName, password, phone } from "../dto/auth.dto";
import { dalamTransaksi } from "../services/admin-audit.service";
import { simpanAdmin } from "../services/admin-akun.service";

const adminSchema = z.object({ fullName, phone, password });

export async function createAdmin(input: {
  phone: string;
  fullName: string;
  password: string;
}): Promise<{ id: number }> {
  const parsed = adminSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  // bootstrap: admin super, sandi dipilih operator lewat env jadi tidak wajib diganti
  const id = await dalamTransaksi((conn) =>
    simpanAdmin(
      conn,
      { full_name: parsed.data.fullName, phone: parsed.data.phone, password: parsed.data.password },
      "super",
      false,
    ),
  );
  return { id };
}

const getOption = (argv: string[], flag: string) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
};

// Mengembalikan kode keluar proses. Sandi hanya dari env dan tidak pernah dicetak.
export async function run(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const password = env.ADMIN_INITIAL_PASSWORD;
  if (!password) {
    console.error("ADMIN_INITIAL_PASSWORD belum diisi.");
    return 1;
  }
  const phone = getOption(argv, "--phone");
  const name = getOption(argv, "--name");
  if (!phone || !name) {
    console.error('Pemakaian: npm run admin:create -- --phone 08xxxxxxxxxx --name "Nama Admin"');
    return 1;
  }
  try {
    const { id } = await createAdmin({ phone, fullName: name, password });
    console.log(`Admin dibuat (id ${id}).`);
    return 0;
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }
}

if (require.main === module) {
  run(process.argv.slice(2), process.env)
    .then((code) => db.end().then(() => process.exit(code)))
    .catch((error) => {
      console.error((error as Error).message);
      process.exit(1);
    });
}
