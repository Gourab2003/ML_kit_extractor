// Entry point: recognised text in -> filled form out.
import type { OcrLine, DocType, Extraction, VehicleRecord, Field } from "./types.ts";
import { parseSealing } from "./sealing.ts";
import { parseSlip } from "./slips.ts";
import { parseDate } from "./normalize.ts";

export * from "./types.ts";
export { normalizeVehicle, leadSealCount, toMt, parseDate, parseTime } from "./normalize.ts";

const SIGNS: [DocType, RegExp[]][] = [
  ["sealing", [/xconics/i, /valve/i, /lead\s*no/i, /camera/i, /sealed/i, /vehicle\s*no/i]],
  ["aegis_gp", [/aegis/i, /vopak/i, /gatepass/i, /tare\s*date/i, /shipment/i, /delivery\s*challan/i]],
  ["ruchi_slip", [/ruchi/i, /first\s*weight/i, /second\s*weight/i, /dockzone|dock\s*zone/i, /time\s*in/i]],
  ["avr_gp", [/avr/i, /tanker\s*truck/i, /gate\s*pass/i, /b\.?e\.?\s*&\s*do/i, /surveyor/i, /intertek/i]],
  ["hpl_bol", [/haldia\s*petro/i, /bill\s*of\s*lading/i, /truck\s*reg/i, /order\s*number/i, /card\s*number/i]],
];

/** Which document is this? Returns the best match and a score (number of signs found). */
export function detectType(lines: OcrLine[]): { type: DocType; score: number } {
  const text = lines.map((l) => l.text).join("\n");
  let best: DocType = "unknown", score = 0;
  for (const [type, signs] of SIGNS) {
    const s = signs.filter((re) => re.test(text)).length;
    if (s > score) { best = type; score = s; }
  }
  return score >= 2 ? { type: best, score } : { type: "unknown", score };
}

export function countToCheck(records: VehicleRecord[], date?: Field<string>): number {
  let n = date && !date.ok ? 1 : 0;
  for (const r of records) for (const f of Object.values(r)) if (f && typeof f === "object" && "ok" in f && !(f as Field<unknown>).ok) n++;
  return n;
}

export function extract(input: OcrLine[], forceType?: DocType): Extraction {
  const lines = [...input].sort((a, b) => a.box.top - b.box.top || a.box.left - b.box.left);
  const { type } = forceType ? { type: forceType } : detectType(lines);
  const text = lines.map((l) => l.text).join("\n");
  let records: VehicleRecord[] = [], warnings: string[] = [], date: string | null = null;

  if (type === "sealing") {
    ({ records, warnings } = parseSealing(lines));
    const dl = lines.find((l) => /date/i.test(l.text) && parseDate(l.text));
    date = dl ? parseDate(dl.text) : parseDate(text);
  } else if (type !== "unknown") {
    ({ records, warnings, date } = parseSlip(lines, type));
  } else {
    warnings.push("Could not tell which document this is. Choose the type and try again, or fill in by hand.");
  }
  const dateF: Field<string> = date ? { value: date, ok: true } : { value: "", ok: false, note: "Date not read" };
  return { docType: type, date: dateF, records, toCheck: countToCheck(records, dateF), engine: "mlkit", warnings };
}
