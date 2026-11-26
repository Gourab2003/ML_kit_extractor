// Everything is saved on the phone first (works with no signal), then sent when there is internet.
import { Directory, File, Paths } from "expo-file-system";
import * as Network from "expo-network";
import type { Extraction, VehicleRecord, DocType } from "./engine/index.ts";

export interface Settings {
  serverUrl: string; // e.g. https://field.xconics.com  (empty = only save on phone)
  apiKey: string;
  site: string; // AEGIS, RUCHI, AVR, HPL, DURGAPUR
  staff: string;
  engine: "mlkit" | "server";
}
export const SITES = ["AEGIS", "RUCHI", "AVR", "HPL", "DURGAPUR"];
const DEFAULTS: Settings = { serverUrl: "", apiKey: "", site: "AEGIS", staff: "", engine: "mlkit" };

export interface Submission {
  id: string;
  createdAt: string;
  site: string;
  staff: string;
  docType: DocType;
  date: string;
  engine: "mlkit" | "server";
  readMs: number;
  rotation: number;
  /** what the app read, untouched - to measure accuracy */
  original: Extraction;
  /** what the staff confirmed */
  records: VehicleRecord[];
  /** fields the staff had to change, e.g. "2.vehicle" (row 3's vehicle) */
  changed: string[];
  fieldsTotal: number;
  photo: string; // file name inside the submission folder
}

const root = () => Paths.document;
const settingsFile = () => new File(root(), "settings.json");
const outbox = () => new Directory(root(), "outbox");
const sent = () => new Directory(root(), "sent");

function ensure(d: Directory) { if (!d.exists) d.create({ intermediates: true, idempotent: true }); return d; }

export async function loadSettings(): Promise<Settings> {
  const f = settingsFile();
  if (!f.exists) return { ...DEFAULTS };
  try { return { ...DEFAULTS, ...JSON.parse(await f.text()) }; } catch { return { ...DEFAULTS }; }
}
export function saveSettings(s: Settings) {
  const f = settingsFile();
  if (!f.exists) f.create();
  f.writeSync(JSON.stringify(s));
}

export async function saveSubmission(sub: Submission, photoUri: string) {
  const dir = ensure(new Directory(ensure(outbox()), sub.id));
  await new File(photoUri).copy(new File(dir, "photo.jpg"));
  // data.json is written last: a folder without it is an unfinished save and is ignored
  const f = new File(dir, "data.json");
  f.create();
  f.writeSync(JSON.stringify(sub));
}

function listSubs(d: Directory): Submission[] {
  if (!d.exists) return [];
  const out: Submission[] = [];
  for (const item of d.list()) {
    if (!(item instanceof Directory)) continue;
    const f = new File(item, "data.json");
    if (f.exists) { try { out.push(JSON.parse(f.textSync())); } catch { /* skip broken */ } }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export const pending = () => listSubs(outbox());
export const history = () => [...listSubs(outbox()), ...listSubs(sent())].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

/** Send waiting submissions. Returns how many went. Safe to call often. */
let syncing = false;
export async function sync(s: Settings): Promise<{ sent: number; left: number; error?: string }> {
  const waiting = pending();
  if (!s.serverUrl || !waiting.length || syncing) return { sent: 0, left: waiting.length };
  const net = await Network.getNetworkStateAsync();
  if (!net.isInternetReachable) return { sent: 0, left: waiting.length };
  syncing = true;
  let n = 0;
  try {
    for (const sub of waiting.reverse()) {
      const dir = new Directory(outbox(), sub.id);
      const body = new FormData();
      body.append("data", JSON.stringify(sub));
      body.append("photo", { uri: new File(dir, "photo.jpg").uri, name: `${sub.id}.jpg`, type: "image/jpeg" } as unknown as Blob);
      const res = await fetch(`${s.serverUrl.replace(/\/$/, "")}/submissions`, { method: "POST", headers: { "x-api-key": s.apiKey }, body });
      if (!res.ok) throw new Error(`Server said ${res.status}`);
      ensure(sent());
      await dir.move(new Directory(sent(), sub.id));
      n++;
    }
    return { sent: n, left: pending().length };
  } catch (e) {
    return { sent: n, left: pending().length, error: (e as Error).message };
  } finally { syncing = false; }
}

/** Server reading (AI). Sends one compressed photo (~150-250 KB). */
export async function readOnServer(s: Settings, photoUri: string, hint?: DocType): Promise<Extraction> {
  if (!s.serverUrl) throw new Error("No server set in Settings");
  const body = new FormData();
  body.append("photo", { uri: photoUri, name: "challan.jpg", type: "image/jpeg" } as unknown as Blob);
  if (hint) body.append("docType", hint);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(`${s.serverUrl.replace(/\/$/, "")}/extract`, { method: "POST", headers: { "x-api-key": s.apiKey }, body, signal: ctrl.signal });
    if (!res.ok) throw new Error(`Server said ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as Extraction;
  } finally { clearTimeout(timer); }
}
