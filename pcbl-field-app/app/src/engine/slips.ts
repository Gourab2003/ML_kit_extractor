// Reads single-vehicle weight documents: Aegis gate pass, Ruchi weighbridge slip, AVR gate pass, HPL bill of lading.
// Each field is found by its printed label; the value is taken from the same line after the label,
// or from the text to the right on the same row (photos often split label and value into separate lines).
import type { OcrLine, VehicleRecord, Field, DocType } from "./types.ts";
import { normalizeVehicle, toMt, parseDate } from "./normalize.ts";

const cy = (b: { top: number; bottom: number }) => (b.top + b.bottom) / 2;
const hgt = (b: { top: number; bottom: number }) => b.bottom - b.top;

/** Text that belongs to a label: rest of its line, else lines to the right on the same row, else the line just below. */
export function valueFor(lines: OcrLine[], label: RegExp, pick: RegExp): string | null {
  for (const line of lines) {
    const m = line.text.match(label);
    if (!m) continue;
    const after = line.text.slice((m.index ?? 0) + m[0].length).replace(/^[\s:.\-=]+/, "");
    const v1 = after.match(pick);
    if (v1) return v1[0];
    const rowH = hgt(line.box) || 20;
    const right = lines
      .filter((o) => o !== line && o.box.left >= line.box.right - rowH && Math.abs(cy(o.box) - cy(line.box)) < rowH * 0.7)
      .sort((a, b) => a.box.left - b.box.left);
    for (const o of right) { const v = o.text.replace(/^[\s:.\-=]+/, "").match(pick); if (v) return v[0]; }
    const below = lines
      .filter((o) => o.box.top >= line.box.bottom - 2 && o.box.top - line.box.bottom < rowH * 1.2 && Math.abs(o.box.left - line.box.left) < rowH * 4)
      .sort((a, b) => a.box.top - b.box.top)[0];
    const v3 = below?.text.match(pick);
    if (v3) return v3[0];
  }
  return null;
}

const NUM = /\d[\d,]*(?:\.\d+)?/;
const PLATE = /[A-Z]{2}\s*\d{1,2}\s*[A-Z]{0,3}\s*\d{3,4}|\d{2}\s*BH\s*\d{4}\s*[A-Z]{1,2}/i;

interface Spec {
  vehicle: RegExp; gross: RegExp; tare: RegExp; net: RegExp; gp?: RegExp; gpPick?: RegExp; challan?: RegExp; date: RegExp;
  /** Ruchi prints "First/Second weight": the smaller is tare. */
  firstSecond?: boolean;
}
const SPECS: Record<Exclude<DocType, "sealing" | "unknown">, Spec> = {
  aegis_gp: { vehicle: /vehicle\s*no\.?/i, gross: /gross\s*weight\s*\(?m\.?t\.?\)?/i, tare: /\btare\b/i, net: /\bnett?\b/i,
    gp: /gp\.?\s*no\.?/i, gpPick: /\d{6,12}/, challan: /delivery\s*challan\s*no/i, date: /\bdate\b/i },
  ruchi_slip: { vehicle: /truck\s*no\.?/i, gross: /second\s*weight/i, tare: /first\s*weight/i, net: /net\s*weight/i,
    gp: /gate\s*pass\s*no\.?/i, gpPick: /\d{3,8}/, date: /\b(in|out)\b\s*:?/i, firstSecond: true },
  avr_gp: { vehicle: /tanker\s*truck\s*no\.?|truck\s*no\.?/i, gross: /\bgross\b/i, tare: /\btare\b/i, net: /\bnet\b/i,
    gp: /gp\.?\s*no\.?/i, gpPick: /\d{4,10}/, date: /gp\s*dt\.?|entry\s*dt\.?/i },
  hpl_bol: { vehicle: /truck\s*reg\.?\s*no\.?/i, gross: /gross\s*weight/i, tare: /tare\s*weight/i, net: /net\s*weight/i,
    gp: /order\s*number/i, gpPick: /\d{6,12}/, date: /order\s*date/i },
};

export function parseSlip(lines: OcrLine[], docType: DocType): { records: VehicleRecord[]; date: string | null; warnings: string[] } {
  const spec = SPECS[docType as keyof typeof SPECS];
  const warnings: string[] = [];
  if (!spec) return { records: [], date: null, warnings: ["Document type not recognised - fill in by hand."] };

  const vehicleRaw = valueFor(lines, spec.vehicle, PLATE) ?? "";
  let tare = toMt(valueFor(lines, spec.tare, NUM));
  let gross = toMt(valueFor(lines, spec.gross, NUM));
  const net = toMt(valueFor(lines, spec.net, NUM));
  if (spec.firstSecond && tare !== null && gross !== null && tare > gross) [tare, gross] = [gross, tare];
  const gp = spec.gp ? valueFor(lines, spec.gp, spec.gpPick!) : null;
  const challan = spec.challan ? valueFor(lines, spec.challan, /\d{6,12}/) : null;
  const dateRaw = valueFor(lines, spec.date, /\d{1,2}\s*[\/.\-]\s*\d{1,2}\s*[\/.\-]\s*\d{2,4}/);
  const date = dateRaw ? parseDate(dateRaw) : null;

  // Weights must add up: net = gross - tare (allow 10 kg rounding)
  const sumOk = tare !== null && gross !== null && net !== null && Math.abs(gross - tare - net) <= 0.01 && gross > tare;
  const w = (v: number | null, name: string): Field<number | null> =>
    v === null ? { value: null, ok: false, note: `${name} not read` }
      : sumOk ? { value: v, ok: true } : { value: v, ok: false, note: "Gross - Tare does not equal Net - check" };

  // Fill a missing third weight from the other two (flagged, never silently)
  let tareF = w(tare, "Tare"), grossF = w(gross, "Gross"), netF = w(net, "Net");
  if (net === null && tare !== null && gross !== null && gross > tare) netF = { value: Math.round((gross - tare) * 1000) / 1000, ok: false, note: "Net calculated from Gross - Tare" };
  if (tare === null && gross !== null && net !== null) tareF = { value: Math.round((gross - net) * 1000) / 1000, ok: false, note: "Tare calculated from Gross - Net" };
  if (gross === null && tare !== null && net !== null) grossF = { value: Math.round((tare + net) * 1000) / 1000, ok: false, note: "Gross calculated from Tare + Net" };

  const rec: VehicleRecord = {
    vehicle: normalizeVehicle(vehicleRaw),
    tareMt: tareF, grossMt: grossF, netMt: netF,
    gpNo: gp ? { value: gp, ok: true } : { value: "", ok: false, note: "Gate pass / document no. not read" },
  };
  if (spec.challan) rec.challanNo = challan ? { value: challan, ok: true } : { value: "", ok: false, note: "Challan no. not read" };
  return { records: [rec], date, warnings };
}
