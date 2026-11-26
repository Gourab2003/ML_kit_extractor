// Run: node --test app/src/engine/   (Node 22.18+ runs TypeScript directly)
// Layouts are modelled on the real samples (Aegis/Ruchi sealing challans of 13-10-2026, Aegis GP 0005191003,
// Ruchi slip WB23C1452, AVR GP 151508, HPL BoL GJ39T5037). Real ML Kit output from phones will be added as
// fixtures once the app is in testers' hands (Debug -> "Export OCR").
import { test } from "node:test";
import assert from "node:assert/strict";
import { extract, detectType, normalizeVehicle, leadSealCount, type OcrLine } from "./index.ts";

/** Build an OCR line at (x,y); words get proportional widths, like ML Kit. */
function L(text: string, x: number, y: number, w = text.length * 11, hgt = 22): OcrLine {
  const parts = text.split(" ").filter(Boolean);
  const total = parts.join("").length || 1;
  let cx = x;
  const words = parts.map((p) => {
    const ww = (p.length / total) * w;
    const box = { left: cx, top: y, right: cx + ww, bottom: y + hgt };
    cx += ww + 6;
    return { text: p, box };
  });
  return { text, box: { left: x, top: y, right: x + w, bottom: y + hgt }, words };
}

// ---------- plates and seals ----------
test("vehicle numbers are normalised", () => {
  assert.deepEqual(normalizeVehicle("wb 29a 0775."), { value: "WB29A0775", ok: true });
  assert.equal(normalizeVehicle("WB39B/5276").value, "WB39B5276");
  assert.equal(normalizeVehicle("WB 29 5527").value, "WB295527");
  assert.equal(normalizeVehicle("GJ 12BZ 9192").value, "GJ12BZ9192");
  assert.equal(normalizeVehicle("22BH1234AA").ok, true);
  const fixed = normalizeVehicle("W8 29A O775");
  assert.equal(fixed.value, "WB29A0775");
  assert.equal(fixed.ok, false, "a repaired plate must be flagged for checking");
  assert.equal(normalizeVehicle("XX12").ok, false);
});

test("lead seal rule: first number = box of 8, each extra = 1", () => {
  assert.equal(leadSealCount(["225", "212", "212"]), 10);
  assert.equal(leadSealCount(["205"]), 8);
  assert.equal(leadSealCount([]), 0);
});

// ---------- sealing challan: Aegis, 13/10/26 (handwritten, many rows) ----------
function aegisSealing(): OcrLine[] {
  const X = { sl: 40, veh: 130, valve: 390, lead: 520, cam: 650, time: 740 };
  const lines = [
    L("XCONICS INNOVATIONS PVT LTD.", 150, 20, 420, 30),
    L("Depot: AEGIS / AVR", 20, 70), L("HALDIA PCBL", 330, 70), L("Date: 13 / 10 / 26", 600, 70),
    L("Sl. No.", 30, 115, 50), L("Vehicle No.", 170, 115, 120), L("Valve Box No.", 380, 115, 130),
    L("Lead No.", 530, 115, 90), L("Camera No.", 650, 110, 70), L("Time", 745, 115, 50),
  ];
  const rows: [string, string, string[], string, string][] = [
    ["WB 29B 1275.", "210, 231.", ["225,", "212:", "212"], "(342)", "10:26"],
    ["WB 41F 3843", "219, 220", ["207"], "(356)", "10:22"],
    ["WB 29A 9027", "205, 213", ["208,", "244:", "244"], "(326)", "11:32"],
    ["WB 29A 0775", "230, 224", ["220"], "(331)", "10:45"],
    ["WB 29 5527", "211, 202", ["205"], "(167)", "10:49"],
    ["WB 29B 4327.", "234, 227", ["222,", "204:", "204"], "(625)", "12:25"],
  ];
  rows.forEach(([veh, valve, lead, cam, time], i) => {
    const y = 160 + i * 34;
    lines.push(L(`${i + 1}/`, X.sl, y, 30));
    lines.push(L(veh, X.veh, y, 170));
    lines.push(L(valve, X.valve, y, 100));
    // stacked cell: first number on the line, the extra seals written small above/below
    lines.push(L(lead[0], X.lead, y, 40));
    if (lead.length > 1) { lines.push(L(lead[1], X.lead + 48, y - 6, 36, 14)); lines.push(L(lead[2], X.lead + 48, y + 9, 36, 14)); }
    lines.push(L(cam, X.cam, y, 55));
    lines.push(L(time, X.time, y, 50));
  });
  lines.push(L("Approved/Sealed By", 20, 400, 160));
  return lines;
}

test("Aegis sealing challan: all rows filled, seals counted", () => {
  const r = extract(aegisSealing());
  assert.equal(r.docType, "sealing");
  assert.equal(r.date.value, "2026-10-13");
  assert.equal(r.records.length, 6);
  const first = r.records[0];
  assert.equal(first.vehicle.value, "WB29B1275");
  assert.deepEqual(first.valveSeals!.value, ["210", "231"]);
  assert.deepEqual(first.leadSeals!.value, ["225", "212", "212"]);
  assert.equal(first.sealCount!.value, 10);
  assert.equal(first.cameraNo!.value, "342");
  assert.equal(first.time!.value, "10:26");
  assert.equal(r.records[1].sealCount!.value, 8);
  assert.equal(r.records[4].vehicle.value, "WB295527");
  assert.equal(r.records[5].vehicle.value, "WB29B4327");
  assert.equal(r.toCheck, 0, JSON.stringify(r.records.flatMap((x) => Object.values(x).filter((f: any) => !f.ok)), null, 1));
});

test("sealing challan: misread plate is flagged, not silently accepted", () => {
  const lines = aegisSealing();
  const veh = lines.find((l) => l.text === "WB 41F 3843")!;
  veh.text = "W8 41F 3843"; veh.words[0].text = "W8";
  const r = extract(lines);
  assert.equal(r.records[1].vehicle.value, "WB41F3843");
  assert.equal(r.records[1].vehicle.ok, false);
  assert.equal(r.toCheck, 1);
});

test("sealing challan photographed without the header row: rows still found, flagged", () => {
  const lines = aegisSealing().filter((l) => l.box.top > 140);
  const r = extract(lines, "sealing");
  assert.equal(r.records.length, 6);
  assert.equal(r.records[0].vehicle.value, "WB29B1275");
  assert.equal(r.records[0].cameraNo!.value, "342");
  assert.ok(r.warnings.some((w) => /header/i.test(w)));
});

// ---------- weight documents (one vehicle each) ----------
test("Aegis gate pass (photo of the printed GP)", () => {
  const t = [
    "Aegis Vopak Terminals Limited", "GATEPASS- DELIVERY",
    "Time: 11:08:06 Date: 13.10.2026 GP.No. : 0005191003",
    "Vehicle No : WB29B4327", "TD Shipment Document No: 4003698580",
    "Delivery Challan No&Date : 8082044134/13.10.2026",
    "Gross Weight(M.T) : 34.910 Gross Date & Time : 13.10.2026 12:12:27",
    "Tare : 10.960 Tare Date & Time : 13.10.2026 10:53:06",
    "Nett : 23.950",
  ];
  const r = extract(t.map((s, i) => L(s, 20, 20 + i * 30)));
  assert.equal(r.docType, "aegis_gp");
  const v = r.records[0];
  assert.equal(v.vehicle.value, "WB29B4327");
  assert.equal(v.grossMt!.value, 34.91);
  assert.equal(v.tareMt!.value, 10.96);
  assert.equal(v.netMt!.value, 23.95);
  assert.equal(v.gpNo!.value, "0005191003");
  assert.equal(v.challanNo!.value, "8082044134");
  assert.equal(r.date.value, "2026-10-13");
  assert.equal(r.toCheck, 0);
});

test("Ruchi weighbridge slip: labels and values in separate columns, kg -> MT, first/second weight", () => {
  const rows: [string, string][] = [
    ["Truck No.", ": WB23C1452"], ["Gate Pass No.", ": 5043"], ["Product Name", ": CBFS"],
    ["First Weight", ": 10660 Kg"], ["Second Weight", ": 034710 Kg"], ["Net Weight", ": 24050 Kg"],
    ["In", ": 13-10-2026 Time In : 09:52:48"],
  ];
  const lines = [L("RUCHI INFRASTRUCTURE LTD", 100, 10), L("TERMINAL - II, DOCKZONE, CHIRANJIBPUR", 60, 40)];
  rows.forEach(([a, b], i) => { lines.push(L(a, 20, 90 + i * 30, 150)); lines.push(L(b, 200, 90 + i * 30, 220)); });
  const r = extract(lines);
  assert.equal(r.docType, "ruchi_slip");
  const v = r.records[0];
  assert.equal(v.vehicle.value, "WB23C1452");
  assert.equal(v.tareMt!.value, 10.66);
  assert.equal(v.grossMt!.value, 34.71);
  assert.equal(v.netMt!.value, 24.05);
  assert.equal(v.gpNo!.value, "5043");
  assert.equal(r.date.value, "2026-10-13");
  assert.equal(r.toCheck, 0);
});

test("AVR gate pass (dot-matrix)", () => {
  const t = [
    "GATE PASS", "GP. No. : 151508", "Entry Dt.: 24/09/26", "Customer PCBL CHEMICAL",
    "Tanker Truck No. : WB29A1477", "B.E & DO Details : Type BENo", "Gross 28.170 KB. 24/09/26:14:38:00",
    "Tare 9.060 WB1 24/09/26 13:13:00", "Net 19.110", "Surveyor Intertek", "For AVRSTPL",
  ];
  const r = extract(t.map((s, i) => L(s, 20, 20 + i * 30)));
  assert.equal(r.docType, "avr_gp");
  const v = r.records[0];
  assert.equal(v.vehicle.value, "WB29A1477");
  assert.deepEqual([v.grossMt!.value, v.tareMt!.value, v.netMt!.value], [28.17, 9.06, 19.11]);
  assert.equal(v.gpNo!.value, "151508");
  assert.equal(r.date.value, "2026-09-24");
  assert.equal(r.toCheck, 0);
});

test("HPL bill of lading (kg)", () => {
  const t = [
    "Haldia Petrochemicals Limited", "Bill of Lading", "Order Date : 23-10-2026 01:05:52 PM", "Order Number: 0810978889",
    "Truck Reg. No : GJ39T5037", "Card Number: 275", "Tare Weight: 16530", "Gross Weight: 54470", "Net Weight: 37940",
  ];
  const r = extract(t.map((s, i) => L(s, 20, 20 + i * 30)));
  assert.equal(r.docType, "hpl_bol");
  const v = r.records[0];
  assert.equal(v.vehicle.value, "GJ39T5037");
  assert.deepEqual([v.tareMt!.value, v.grossMt!.value, v.netMt!.value], [16.53, 54.47, 37.94]);
  assert.equal(r.date.value, "2026-10-23");
  assert.equal(r.toCheck, 0);
});

test("weights that don't add up are flagged", () => {
  const t = ["Aegis Vopak Terminals Limited", "GATEPASS- DELIVERY", "Delivery Challan No&Date : 8082044134", "Vehicle No : WB29B4327",
    "Gross Weight(M.T) : 34.910", "Tare : 10.960 Tare Date & Time", "Nett : 28.950"];
  const r = extract(t.map((s, i) => L(s, 20, 20 + i * 30)));
  assert.equal(r.records[0].netMt!.ok, false);
  assert.ok(r.toCheck >= 3);
});

test("unrelated photo is not forced into a form", () => {
  assert.equal(detectType([L("Happy birthday", 0, 0), L("see you soon", 0, 30)]).type, "unknown");
});
