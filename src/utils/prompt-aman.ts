// Keamanan teks pengguna sebelum masuk prompt AI (rubrik: filter prompt injection + anonimisasi).
// Lapis kode ini melengkapi aturan di prompt ("data, bukan instruksi"): permintaan yang jelas mencoba
// mengambil alih AI ditolak sebelum dikirim, dan data pribadi diganti penanda sebelum keluar ke penyedia AI.

const POLA_INJEKSI: RegExp[] = [
  // "abaikan/lupakan … instruksi/perintah/prompt" atau "… aturan sebelumnya/di atas/sistem"
  /\b(abaikan|lupakan|acuhkan|hiraukan)\b.{0,40}\b(instruksi|perintah|prompt|aturan\s+(di\s*atas|sebelumnya|sistem))/i,
  /\b(ignore|disregard|forget|override)\b.{0,40}\b(instructions?|prompts?|rules?)\b/i,
  /\b(system|sistem)\s*prompt\b|\bprompt\s*(system|sistem)\b/i,
  /\b(kamu|anda)\s+(sekarang|kini)\s+(adalah|jadi|menjadi)\b/i,
  /\byou\s+are\s+now\b/i,
  /\b(jailbreak|developer\s+mode|dan\s+mode)\b/i,
  /<\/?\s*(system|assistant|instructions?)\s*>/i,
  /\b(role|peran)\s*:\s*(system|sistem|assistant)\b/i,
  /\b(bocorkan|ungkapkan|tampilkan|reveal|print|show)\b.{0,30}\b(instruksi|prompt|system prompt)\b/i,
  // berpura-pura menjadi bagian data prompt
  /^\s*(DATA_TOKO|KANDIDAT|PERMINTAAN|PERTANYAAN PENJUAL|ANGGARAN|PORSI)\s*:/im,
];

/** true bila teks berisi pola percobaan prompt injection. */
export const adaInjeksi = (teks: string): boolean => POLA_INJEKSI.some((p) => p.test(teks));

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu;
const NIK = /(?<!\d)\d{16}(?!\d)/g;
// 08…, 62 8…, +62 8…; pemisah spasi/titik/strip. Panjang angka dicek di bawah (9–15 digit).
const TELEPON = /(?<![\d\p{L}])(\+?62|0)[\s.-]?8\d{1,3}([\s.-]?\d{2,5}){1,4}(?!\d)/gu;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Ganti data pribadi dengan penanda: email → [email], NIK → [nik], nomor HP → [nomor],
 * dan kata dari nama yang diketahui (≥ 3 huruf) → [nama].
 */
export function samarkan(teks: string, o: { nama?: string[] } = {}): string {
  let hasil = teks
    .replace(EMAIL, "[email]")
    .replace(NIK, "[nik]")
    .replace(TELEPON, (m) => {
      const digit = m.replace(/\D/g, "").length;
      return digit >= 9 && digit <= 15 ? "[nomor]" : m;
    });
  const kata = [...new Set((o.nama ?? []).flatMap((n) => n.split(/\s+/)).map((k) => k.trim()).filter((k) => k.length >= 3))];
  if (kata.length) {
    hasil = hasil.replace(new RegExp(`(?<![\\p{L}\\p{N}])(${kata.map(escape).join("|")})(?![\\p{L}\\p{N}])`, "giu"), "[nama]");
  }
  return hasil;
}
