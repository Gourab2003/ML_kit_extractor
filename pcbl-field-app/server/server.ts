// PCBL field prototype server. No npm dependencies: Node 22 runs this TypeScript directly.
//   POST /extract       photo -> Claude reads it -> same form JSON as the phone engine (fields to check are flagged)
//   POST /submissions   a confirmed challan from a phone (JSON + photo) -> saved under DATA_DIR
//   GET  /submissions   list of what has arrived (for checking the test)
//   GET  /healthz
// Every request except /healthz needs the header  x-api-key: <API_KEY>
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { normalizeVehicle, leadSealCount, toMt, parseDate, parseTime, countToCheck, DOC_LABELS, type DocType, type Extraction, type VehicleRecord, type Field } from "../app/src/engine/index.ts";

const PORT = Number(process.env.PORT || 8090);
const API_KEY = process.env.API_KEY || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const ANTHROPIC_URL = process.env.ANTHROPIC_URL || "https://api.anthropic.com/v1/messages"; // overridable for tests
const DATA_DIR = process.env.DATA_DIR || "./data";
const MAX_BYTES = 8 * 1024 * 1024;
if (!API_KEY) { console.error("API_KEY is required"); process.exit(1); }
fs.mkdirSync(path.join(DATA_DIR, "submissions"), { recursive: true });

const PROMPT = `You read logistics documents photographed at PCBL loading sites in India. Return ONLY JSON, no other text.

Document types:
- "sealing": XCONICS sealing challan, a handwritten table. Columns: Sl No, Vehicle No, Valve Box No, Lead No, Camera No, Time. One record per row.
- "aegis_gp": Aegis Vopak gate pass (printed). One record.
- "ruchi_slip": Ruchi Infrastructure weighbridge slip (thermal print, often sideways). First weight = tare, second weight = gross, in kg. One record.
- "avr_gp": AVR gate pass (dot-matrix). Gross/Tare/Net in MT. One record.
- "hpl_bol": Haldia Petrochemicals bill of lading. Tare/Gross/Net Weight in kg. One record.

JSON shape:
{"docType": "...", "date": "DD/MM/YYYY or null",
 "records": [{"vehicle": "as written", "valveSeals": ["..."], "leadSeals": ["..."], "cameraNo": "...", "time": "HH:MM",
              "tare": "as printed", "gross": "as printed", "net": "as printed", "unit": "kg|MT",
              "gpNo": "...", "challanNo": "...", "uncertain": ["field names you are not sure about"]}]}

Rules:
- Copy numbers exactly as written. Never calculate, never guess. If unreadable, use null and list the field in "uncertain".
- Lead seals: list EVERY number written in the cell, in order, including small numbers written above/below (e.g. "225, 212:212" -> ["225","212","212"]).
- Camera No is usually in brackets, e.g. "(342)" -> "342".
- Ignore crossed-out rows. Ignore tick marks in the Sl No column.
- Omit fields that don't apply to the document type.`;

async function claudeRead(jpeg: Buffer, hint?: string): Promise<any> {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set on the server");
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL, max_tokens: 4000,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") } },
        { type: "text", text: PROMPT + (hint ? `\nThe user says this is: ${hint}.` : "") },
      ] }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const out: any = await res.json();
  const text = out.content?.map((c: any) => c.text || "").join("") || "";
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(json);
}

/** Turn Claude's raw answer into the same checked form the phone engine produces. */
function toExtraction(raw: any): Extraction {
  const docType: DocType = (Object.keys(DOC_LABELS) as DocType[]).includes(raw.docType) ? raw.docType : "unknown";
  const d = raw.date ? parseDate(String(raw.date)) : null;
  const date: Field<string> = d ? { value: d, ok: true } : { value: "", ok: false, note: "Date not read" };
  const records: VehicleRecord[] = (raw.records || []).map((r: any) => {
    const unsure = new Set<string>(r.uncertain || []);
    const flag = <T,>(name: string, f: Field<T>): Field<T> => (unsure.has(name) && f.ok ? { ...f, ok: false, note: "AI not sure - check" } : f);
    const rec: VehicleRecord = { vehicle: flag("vehicle", normalizeVehicle(r.vehicle || "")) };
    if (docType === "sealing") {
      const valve = (r.valveSeals || []).map(String), lead = (r.leadSeals || []).map(String);
      const t = r.time ? parseTime(String(r.time)) : null;
      rec.valveSeals = flag("valveSeals", valve.length ? { value: valve, ok: true } : { value: [], ok: false, note: "Valve box seals not read" });
      rec.leadSeals = flag("leadSeals", lead.length ? { value: lead, ok: true } : { value: [], ok: false, note: "Lead seals not read" });
      const n = leadSealCount(lead);
      rec.sealCount = { value: n, ok: rec.leadSeals.ok, note: `${n} lead seals` };
      rec.cameraNo = flag("cameraNo", r.cameraNo ? { value: String(r.cameraNo).replace(/\D/g, ""), ok: true } : { value: "", ok: false, note: "Camera number not read" });
      rec.time = flag("time", t ? { value: t, ok: true } : { value: "", ok: false, note: "Time not read" });
    } else if (docType !== "unknown") {
      // toMt treats values above 200 as kg, so "16530" (kg) and "34.910" (MT) both come out in MT
      const mt = (v: unknown) => toMt(v == null ? null : String(v));
      let tare = mt(r.tare), gross = mt(r.gross); const net = mt(r.net);
      if (tare !== null && gross !== null && tare > gross) [tare, gross] = [gross, tare];
      const sumOk = tare !== null && gross !== null && net !== null && Math.abs(gross - tare - net) <= 0.01;
      const w = (v: number | null, name: string): Field<number | null> => flag(name, v === null ? { value: null, ok: false, note: `${name} not read` } : sumOk ? { value: v, ok: true } : { value: v, ok: false, note: "Gross - Tare does not equal Net - check" });
      rec.tareMt = w(tare, "tare"); rec.grossMt = w(gross, "gross"); rec.netMt = w(net, "net");
      rec.gpNo = flag("gpNo", r.gpNo ? { value: String(r.gpNo), ok: true } : { value: "", ok: false, note: "Document no. not read" });
      if (docType === "aegis_gp") rec.challanNo = flag("challanNo", r.challanNo ? { value: String(r.challanNo).replace(/\D/g, ""), ok: true } : { value: "", ok: false, note: "Challan no. not read" });
    }
    return rec;
  });
  return { docType, date, records, toCheck: countToCheck(records, date), engine: "server", warnings: docType === "unknown" ? ["AI could not tell which document this is."] : [] };
}

async function form(req: http.IncomingMessage): Promise<FormData> {
  const len = Number(req.headers["content-length"] || 0);
  if (len > MAX_BYTES) throw Object.assign(new Error("Photo too large"), { status: 413 });
  const request = new Request("http://local" + req.url, { method: "POST", headers: req.headers as HeadersInit, body: Readable.toWeb(req) as ReadableStream, duplex: "half" } as RequestInit);
  return request.formData();
}

function send(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

http.createServer(async (req, res) => {
  const t0 = Date.now();
  try {
    const url = new URL(req.url || "/", "http://x");
    if (url.pathname === "/healthz") return send(res, 200, { ok: true, model: MODEL, ai: !!ANTHROPIC_API_KEY });
    if (req.headers["x-api-key"] !== API_KEY) return send(res, 401, { error: "Wrong or missing x-api-key" });

    if (req.method === "POST" && url.pathname === "/extract") {
      const fd = await form(req);
      const photo = fd.get("photo") as File | null;
      if (!photo) return send(res, 400, { error: "photo missing" });
      const raw = await claudeRead(Buffer.from(await photo.arrayBuffer()), (fd.get("docType") as string) || undefined);
      const ex = toExtraction(raw);
      ex.ms = Date.now() - t0;
      console.log(`extract ${ex.docType} ${ex.records.length} rows, ${ex.toCheck} to check, ${ex.ms} ms`);
      return send(res, 200, ex);
    }

    if (req.method === "POST" && url.pathname === "/submissions") {
      const fd = await form(req);
      const data = JSON.parse(String(fd.get("data") || "{}"));
      const id = String(data.id || "").replace(/[^\w-]/g, "");
      if (!id) return send(res, 400, { error: "data.id missing" });
      const dir = path.join(DATA_DIR, "submissions", id);
      fs.mkdirSync(dir, { recursive: true });
      const photo = fd.get("photo") as File | null;
      if (photo) fs.writeFileSync(path.join(dir, "photo.jpg"), Buffer.from(await photo.arrayBuffer()));
      fs.writeFileSync(path.join(dir, "data.json"), JSON.stringify(data, null, 1));
      fs.appendFileSync(path.join(DATA_DIR, "index.jsonl"), JSON.stringify({
        id, receivedAt: new Date().toISOString(), site: data.site, staff: data.staff, docType: data.docType, engine: data.engine,
        vehicles: data.records?.length ?? 0, changed: data.changed?.length ?? 0, fields: data.fieldsTotal ?? 0, readMs: data.readMs,
      }) + "\n");
      console.log(`submission ${id} ${data.site} ${data.docType} ${data.records?.length} vehicles, ${data.changed?.length} corrected`);
      return send(res, 200, { ok: true, id });
    }

    if (req.method === "GET" && url.pathname === "/submissions") {
      const f = path.join(DATA_DIR, "index.jsonl");
      const rows = fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
      return send(res, 200, rows.reverse().slice(0, 500));
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    const err = e as Error & { status?: number };
    console.error(req.method, req.url, err.message);
    send(res, err.status || 500, { error: err.message });
  }
}).listen(PORT, () => console.log(`PCBL field server on :${PORT} (AI model ${MODEL}${ANTHROPIC_API_KEY ? "" : ", AI DISABLED: no ANTHROPIC_API_KEY"})`));
