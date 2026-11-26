// Reads a sealing challan (handwritten table, many vehicles) into one record per vehicle.
//
// How: find the header row (Vehicle / Valve / Lead / Camera / Time) to learn where each column is,
// group the words under it into rows using the vehicle numbers as row anchors, then read each cell.
// If the header was cut off in the photo, columns are guessed from what the text looks like.
import type { OcrLine, OcrWord, VehicleRecord, Field } from "./types.ts";
import { normalizeVehicle, numbersIn, parseTime, leadSealCount } from "./normalize.ts";

type Col = "sl" | "vehicle" | "valve" | "lead" | "camera" | "time";
const HEADERS: [Col, RegExp][] = [
  ["sl", /^s[il1]\.?\s*no|^sl\b/i],
  ["vehicle", /vehic|vehicle/i],
  ["valve", /valve|v\.?\s*box|vbox/i],
  ["lead", /lead|^l1$/i],
  ["camera", /camera|cam\b/i],
  ["time", /^time/i],
];

const cx = (b: { left: number; right: number }) => (b.left + b.right) / 2;
const cy = (b: { top: number; bottom: number }) => (b.top + b.bottom) / 2;
const h = (b: { top: number; bottom: number }) => b.bottom - b.top;
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

export function looksLikePlate(t: string): boolean {
  const s = t.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return /^[A-Z]{2}\d{1,2}[A-Z0-9]{0,3}\d{3,4}$/.test(s) || /^(WB|GJ|PB|HR|RJ|OD|JH|BR|UP|MH)/.test(s) && s.length >= 6;
}

export function parseSealing(lines: OcrLine[]): { records: VehicleRecord[]; warnings: string[] } {
  const warnings: string[] = [];
  const words: OcrWord[] = lines.flatMap((l) => (l.words.length ? l.words : [{ text: l.text, box: l.box }]));

  // 1. Header row
  const head: Partial<Record<Col, number>> = {};
  let headerBottom = -Infinity;
  for (const line of lines) {
    for (const [col, re] of HEADERS) {
      if (head[col] === undefined && re.test(line.text.trim())) {
        // header words like "Valve Box No." -> use the whole line's centre
        head[col] = cx(line.box);
        headerBottom = Math.max(headerBottom, line.box.bottom);
      }
    }
  }
  const haveHeader = head.vehicle !== undefined && (head.valve !== undefined || head.lead !== undefined);
  if (!haveHeader) {
    warnings.push("Table header not found - columns guessed from the text. Check every row.");
    return { records: finish(byContent(lines)), warnings };
  }

  // Column boundaries: halfway between neighbouring header centres
  const cols = (Object.entries(head) as [Col, number][]).sort((a, b) => a[1] - b[1]);
  const colOf = (x: number): Col | null => {
    if (!haveHeader) return null;
    for (let i = 0; i < cols.length; i++) {
      const right = i + 1 < cols.length ? (cols[i][1] + cols[i + 1][1]) / 2 : Infinity;
      if (x < right) return cols[i][0];
    }
    return cols[cols.length - 1][0];
  };

  const body = words.filter((w) => cy(w.box) > headerBottom + 2 && !/approved|sealed|^by$/i.test(w.text));
  if (!body.length) return { records: [], warnings: [...warnings, "No rows found under the header."] };
  const lineH = median(body.map((w) => h(w.box))) || 20;

  // 2. Row anchors = words in the vehicle column (or that look like a plate), merged when on the same row
  const isVehicleWord = (w: OcrWord) => {
    const c = colOf(cx(w.box));
    return c ? c === "vehicle" : looksLikePlate(w.text) || /^(WB|GJ|PB|HR|RJ)$/i.test(w.text.replace(/[^A-Za-z]/g, ""));
  };
  const vWords = body.filter(isVehicleWord).sort((a, b) => cy(a.box) - cy(b.box));
  const anchors: { y: number; words: OcrWord[] }[] = [];
  for (const w of vWords) {
    const last = anchors[anchors.length - 1];
    if (last && Math.abs(cy(w.box) - last.y) < lineH * 0.6) { last.words.push(w); last.y = median(last.words.map((x) => cy(x.box))); }
    else anchors.push({ y: cy(w.box), words: [w] });
  }
  // drop anchors that are clearly not plates (stray marks in the column)
  const rows = anchors.filter((a) => a.words.map((w) => w.text).join("").replace(/[^A-Za-z0-9]/g, "").length >= 5);
  if (!rows.length) return { records: [], warnings: [...warnings, "No vehicle numbers found."] };

  // 3. Every other word goes to the nearest row (handles 2 numbers stacked in one cell)
  const cells: Record<Col, OcrWord[]>[] = rows.map(() => ({ sl: [], vehicle: [], valve: [], lead: [], camera: [], time: [] }));
  for (const w of body) {
    const y = cy(w.box);
    let best = -1, dist = Infinity;
    rows.forEach((r, i) => { const d = Math.abs(r.y - y); if (d < dist) { dist = d; best = i; } });
    if (best < 0 || dist > lineH * 1.6) continue; // far from any row: ignore (notes, signatures)
    const col = colOf(cx(w.box));
    if (col) cells[best][col].push(w);
  }

  // 4. Read each row
  const join = (ws: OcrWord[]) => [...ws].sort((a, b) => (Math.abs(cy(a.box) - cy(b.box)) < lineH * 0.5 ? a.box.left - b.box.left : cy(a.box) - cy(b.box))).map((w) => w.text).join(" ");
  return { records: finish(cells.map((c) => ({ vehicle: join(c.vehicle), valve: join(c.valve), lead: join(c.lead), camera: join(c.camera), time: join(c.time) }))), warnings };
}

interface RawRow { vehicle: string; valve: string; lead: string; camera: string; time: string }

/**
 * No header in the photo: each line that looks like a number plate starts a row.
 * Then, left to right on that row: the first group of numbers is the valve box, the rest are lead seals,
 * "(342)" is the camera, "10:26" is the time.
 */
function byContent(lines: OcrLine[]): RawRow[] {
  const plates = lines.filter((l) => looksLikePlate(l.text)).sort((a, b) => cy(a.box) - cy(b.box));
  const lineH = median(lines.map((l) => h(l.box))) || 20;
  const rows: RawRow[] = plates.map((p) => ({ vehicle: p.text, valve: "", lead: "", camera: "", time: "" }));
  const nearest = (y: number) => {
    let best = -1, dist = Infinity;
    plates.forEach((p, i) => { const d = Math.abs(cy(p.box) - y); if (d < dist) { dist = d; best = i; } });
    return dist <= lineH * 1.6 ? best : -1;
  };
  const byRow: OcrLine[][] = plates.map(() => []);
  for (const l of lines) {
    if (plates.includes(l)) continue;
    const i = nearest(cy(l.box));
    if (i >= 0 && l.box.left > plates[i].box.left) byRow[i].push(l);
  }
  byRow.forEach((ls, i) => {
    const r = rows[i];
    for (const l of ls.sort((a, b) => a.box.left - b.box.left)) {
      const t = l.text.trim();
      if (/\(\s*\d{2,4}\s*\)?/.test(t)) r.camera += ` ${t}`;
      else if (parseTime(t)) r.time += ` ${t}`;
      else if (/\d{2,6}/.test(t)) {
        // stacked small numbers sit at almost the same x as the lead cell -> lead
        if (!r.valve) r.valve = t; else r.lead += ` ${t}`;
      }
    }
  });
  return rows;
}

function finish(raw: RawRow[]): VehicleRecord[] {
  const records: VehicleRecord[] = raw.map((c) => {
    const vehicle = normalizeVehicle(c.vehicle);
    const valve = numbersIn(c.valve, 2, 6);
    const lead = numbersIn(c.lead, 2, 6);
    const cam = (c.camera.match(/\d{2,4}/) || [""])[0];
    const t = parseTime(c.time);

    const leadLens = lead.map((n) => n.length);
    const oddLead = lead.length > 1 && new Set(leadLens).size > 1;
    const valveF: Field<string[]> = valve.length ? { value: valve, ok: true } : { value: [], ok: false, note: "Valve box seals not read" };
    const leadF: Field<string[]> = !lead.length ? { value: [], ok: false, note: "Lead seals not read" }
      : oddLead ? { value: lead, ok: false, note: "One lead number has a different length - check" } : { value: lead, ok: true };
    const count = leadSealCount(lead);
    return {
      vehicle,
      valveSeals: valveF,
      leadSeals: leadF,
      sealCount: { value: count, ok: leadF.ok, note: `${count} lead seals (first number = box of 8, each extra = 1)` },
      cameraNo: cam ? { value: cam, ok: true } : { value: "", ok: false, note: "Camera number not read" },
      time: t ? { value: t, ok: true } : { value: "", ok: false, note: "Time not read" },
    };
  });

  // duplicates in one sheet are almost always a misread
  const seen = new Map<string, number>();
  records.forEach((r) => seen.set(r.vehicle.value, (seen.get(r.vehicle.value) || 0) + 1));
  records.forEach((r) => { if (r.vehicle.value && seen.get(r.vehicle.value)! > 1) { r.vehicle.ok = false; r.vehicle.note = "Same vehicle appears twice on this challan"; } });
  return records;
}
