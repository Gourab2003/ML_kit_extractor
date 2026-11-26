import type { Field } from "./types.ts";

// Indian state / UT codes seen on number plates.
const STATES = new Set(
  "AN AP AR AS BR CG CH DD DL DN GA GJ HP HR JH JK KA KL LA LD MH ML MN MP MZ NL OD OR PB PY RJ SK TN TR TS UK UP WB".split(" "),
);

const TO_DIGIT: Record<string, string> = { O: "0", Q: "0", D: "0", I: "1", L: "1", T: "7", Z: "2", S: "5", B: "8", G: "6", A: "4" };
const TO_LETTER: Record<string, string> = { "0": "O", "1": "I", "2": "Z", "5": "S", "8": "B", "6": "G", "4": "A" };

const digits = (s: string) => [...s].map((c) => (/\d/.test(c) ? c : TO_DIGIT[c] ?? c)).join("");
const letters = (s: string) => [...s].map((c) => (/[A-Z]/.test(c) ? c : TO_LETTER[c] ?? c)).join("");

/**
 * Turn what was read ("wb 29a 0775.", "WB39B/5276", "W8 29A O775") into "WB29A0775".
 * ok=false if the plate had to be repaired or still doesn't look like a valid plate.
 */
export function normalizeVehicle(raw: string): Field<string> {
  const s = (raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!s) return { value: "", ok: false, note: "Vehicle number not read" };

  // BH series: 22BH1234AA
  const bh = s.match(/^(\d{2})BH(\d{4})([A-Z]{1,2})$/);
  if (bh) return { value: s, ok: true };

  if (s.length < 6 || s.length > 11) return { value: s, ok: false, note: "Vehicle number length looks wrong" };
  const state = letters(s.slice(0, 2));
  const number = digits(s.slice(-4));
  const mid = s.slice(2, -4);
  // district: 1-2 digits, then series: 0-3 letters
  const m = mid.match(/^(.{1,2}?)(.{0,3})$/);
  let district = digits(mid.slice(0, Math.min(2, mid.length)));
  let series = letters(mid.slice(district.length));
  if (!/^\d{1,2}$/.test(district) && m) { district = digits(m[1]); series = letters(m[2]); }
  const value = `${state}${district}${series}${number}`;
  const valid = STATES.has(state) && /^\d{1,2}$/.test(district) && /^[A-Z]{0,3}$/.test(series) && /^\d{4}$/.test(number);
  const repaired = value !== s;
  if (!valid) return { value, ok: false, note: "Not a valid number plate - check" };
  if (repaired) return { value, ok: false, note: `Read as "${raw.trim()}" - check` };
  return { value, ok: true };
}

/** All numbers in a cell: "210, 231." -> ["210","231"]; "212:212" -> ["212","212"]. Letters that look like digits are fixed. */
export function numbersIn(raw: string, minLen = 2, maxLen = 6): string[] {
  const fixed = (raw || "").toUpperCase().replace(/[OQ]/g, "0").replace(/[IL|]/g, "1").replace(/S(?=\d)|(?<=\d)S/g, "5");
  return (fixed.match(/\d+/g) || []).filter((n) => n.length >= minLen && n.length <= maxLen);
}

/** "11:47", "3.22", "12 :25" -> "11:47". */
export function parseTime(raw: string): string | null {
  const m = (raw || "").replace(/\s/g, "").match(/(\d{1,2})[:.;](\d{2})/);
  if (!m) return null;
  const h = +m[1], min = +m[2];
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

/** "13/10/26", "13.10.2026", "24/09/26", "23-10-2026" -> "2026-10-13". */
export function parseDate(raw: string): string | null {
  const m = (raw || "").match(/(\d{1,2})\s*[\/.\-]\s*(\d{1,2})\s*[\/.\-]\s*(\d{2,4})/);
  if (!m) return null;
  const d = +m[1], mo = +m[2];
  let y = +m[3];
  if (y < 100) y += 2000;
  if (d < 1 || d > 31 || mo < 1 || mo > 12 || y < 2020 || y > 2100) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** A weight as printed ("34.910", "034710", "28,170") -> MT. Values above 200 are taken as kg. */
export function toMt(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const m = String(raw).replace(/,(?=\d{3}\b)/g, "").replace(/,/g, ".").match(/\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0]);
  if (!isFinite(n) || n <= 0) return null;
  return Math.round((n > 200 ? n / 1000 : n) * 1000) / 1000;
}

/**
 * Lead seals rule (from the field team): the first lead number is a box of 8 seals,
 * every further number listed is one more seal. "225, 212, 212" = 10; "205" = 8.
 */
export function leadSealCount(lead: string[]): number {
  return lead.length ? 8 + (lead.length - 1) : 0;
}
