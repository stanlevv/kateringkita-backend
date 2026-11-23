// Keamanan teks pengguna sebelum masuk prompt AI (rubrik: filter prompt injection + anonimisasi).
// Lapis kode ini melengkapi aturan di prompt ("data, bukan instruksi"): permintaan yang jelas mencoba
// mengambil alih AI ditolak sebelum dikirim, dan data pribadi diganti penanda sebelum keluar ke penyedia AI.

const INJECTION_PATTERNS: RegExp[] = [
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
export const hasInjection = (text: string): boolean => INJECTION_PATTERNS.some((pattern) => pattern.test(text));

const EMAIL_PATTERN = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu;
const NIK_PATTERN = /(?<!\d)\d{16}(?!\d)/g;
// 08…, 62 8…, +62 8…; pemisah spasi/titik/strip. Panjang angka dicek di bawah (9–15 digit).
const PHONE_PATTERN = /(?<![\d\p{L}])(\+?62|0)[\s.-]?8\d{1,3}([\s.-]?\d{2,5}){1,4}(?!\d)/gu;

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Ganti data pribadi dengan penanda: email → [email], NIK → [nik], nomor HP → [nomor],
 * dan kata dari nama yang diketahui (≥ 3 huruf) → [nama].
 */
export function anonymize(text: string, options: { names?: string[] } = {}): string {
  let result = text
    .replace(EMAIL_PATTERN, "[email]")
    .replace(NIK_PATTERN, "[nik]")
    .replace(PHONE_PATTERN, (match) => {
      const digitCount = match.replace(/\D/g, "").length;
      return digitCount >= 9 && digitCount <= 15 ? "[nomor]" : match;
    });
  const nameWords = [
    ...new Set(
      (options.names ?? [])
        .flatMap((fullName) => fullName.split(/\s+/))
        .map((word) => word.trim())
        .filter((word) => word.length >= 3),
    ),
  ];
  if (nameWords.length) {
    result = result.replace(
      new RegExp(`(?<![\\p{L}\\p{N}])(${nameWords.map(escapeRegex).join("|")})(?![\\p{L}\\p{N}])`, "giu"),
      "[nama]",
    );
  }
  return result;
}
