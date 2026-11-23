// Isi file: skrip baris perintah untuk membuat admin super pertama (`npm run admin:create -- --phone … --name …`).
// Sandi diambil dari variabel env ADMIN_INITIAL_PASSWORD supaya tidak tertulis di riwayat terminal. Nama file dan
// fungsi `createAdmin` juga dipakai test end-to-end repo web, jadi jangan diganti.
import "dotenv/config"; // harus pertama: env.ts (lewat db.ts) membaca process.env saat diimpor
import { z } from "zod";
import db from "../config/db";
import { fullNameSchema, passwordSchema, phoneSchema } from "../dto/auth.dto";
import { withTransaction } from "../services/admin-audit.service";
import { saveAdmin } from "../services/admin-account.service";

const adminSchema = z.object({ fullName: fullNameSchema, phone: phoneSchema, password: passwordSchema });

/**
 * Membuat akun admin super. Sandinya dipilih sendiri oleh operator lewat env, jadi tidak wajib diganti saat login
 * pertama. Sandi disimpan sebagai hash (hasil acakan satu arah; sandi asli tidak bisa dibaca kembali dari hash).
 * @param input nomor HP, nama lengkap, dan sandi admin
 * @returns id akun admin baru
 * @throws Error berisi pesan kesalahan pertama bila data tidak valid; galat database (contoh nomor sudah terdaftar)
 *         diteruskan apa adanya
 */
export async function createAdmin(input: {
  phone: string;
  fullName: string;
  password: string;
}): Promise<{ id: number }> {
  // 1. Periksa data dengan aturan yang sama seperti pendaftaran biasa.
  const parsed = adminSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  // 2. Simpan sebagai admin tingkat super di dalam transaksi (semua perubahan tersimpan, atau tidak sama sekali).
  const id = await withTransaction((conn) =>
    saveAdmin(
      conn,
      { full_name: parsed.data.fullName, phone: parsed.data.phone, password: parsed.data.password },
      "super",
      false,
    ),
  );
  return { id };
}

// Mengambil nilai sesudah sebuah opsi baris perintah, contoh `--phone 0812…` → "0812…".
const getOption = (argv: string[], flag: string) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
};

/**
 * Menjalankan skrip: membaca opsi `--phone` dan `--name` serta sandi dari env, lalu membuat admin. Sandi tidak pernah
 * dicetak ke layar.
 * @param argv argumen baris perintah (tanpa `node` dan nama file)
 * @param env  variabel lingkungan; dibaca ADMIN_INITIAL_PASSWORD
 * @returns kode keluar proses: 0 berhasil, 1 gagal (pesannya sudah dicetak)
 */
export async function run(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  // 1. Sandi wajib ada di env.
  const password = env.ADMIN_INITIAL_PASSWORD;
  if (!password) {
    console.error("ADMIN_INITIAL_PASSWORD belum diisi.");
    return 1;
  }
  // 2. Nomor HP dan nama wajib diisi lewat opsi.
  const phone = getOption(argv, "--phone");
  const name = getOption(argv, "--name");
  if (!phone || !name) {
    console.error('Pemakaian: npm run admin:create -- --phone 08xxxxxxxxxx --name "Nama Admin"');
    return 1;
  }
  // 3. Buat admin; galat apa pun dicetak sebagai pesan singkat.
  try {
    const { id } = await createAdmin({ phone, fullName: name, password });
    console.log(`Admin dibuat (id ${id}).`);
    return 0;
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }
}

// Hanya berjalan bila file ini dijalankan langsung (bukan diimpor test); pool database ditutup sebelum keluar.
if (require.main === module) {
  run(process.argv.slice(2), process.env)
    .then((code) => db.end().then(() => process.exit(code)))
    .catch((error) => {
      console.error((error as Error).message);
      process.exit(1);
    });
}
