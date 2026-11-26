// The form the staff check before saving. Everything read is already filled in.
// Orange = the app is not sure: the staff either fix it or tap ✓ to confirm it. Save unlocks when nothing is orange.
import { useMemo, useState } from "react";
import { FlatList, Pressable, Text, TextInput, View } from "react-native";
import { DOC_LABELS, leadSealCount, normalizeVehicle, type DocType, type Extraction, type Field, type VehicleRecord } from "./engine/index.ts";
import { s, C } from "./styles.ts";

type Key = keyof VehicleRecord;
const SEALING: [Key, string][] = [["vehicle", "Vehicle no."], ["valveSeals", "Valve box seals"], ["leadSeals", "Lead seals"], ["cameraNo", "Camera no."], ["time", "Time"]];
const SLIP: [Key, string][] = [["vehicle", "Vehicle no."], ["tareMt", "Tare (MT)"], ["grossMt", "Gross (MT)"], ["netMt", "Net (MT)"], ["gpNo", "GP / document no."], ["challanNo", "Challan no."]];
const NUMERIC: Key[] = ["tareMt", "grossMt", "netMt"];
const LIST: Key[] = ["valveSeals", "leadSeals"];

const show = (f?: Field<unknown>) => (f ? (Array.isArray(f.value) ? (f.value as string[]).join(", ") : f.value == null ? "" : String(f.value)) : "");

export interface ReviewResult { date: string; docType: DocType; records: VehicleRecord[]; changed: string[]; fieldsTotal: number }

export function Review({ ex, onSave, onCancel, onDebug }: { ex: Extraction; onSave: (r: ReviewResult) => void; onCancel: () => void; onDebug: () => void }) {
  const [rows, setRows] = useState<VehicleRecord[]>(() => structuredClone(ex.records));
  const [date, setDate] = useState<Field<string>>(ex.date);
  const [changed, setChanged] = useState<Set<string>>(new Set());
  const sealing = ex.docType === "sealing";
  const fields = (sealing ? SEALING : SLIP).filter(([k]) => k !== "challanNo" || rows.some((r) => r.challanNo));

  const toCheck = useMemo(() => {
    let n = date.ok ? 0 : 1;
    rows.forEach((r) => fields.forEach(([k]) => { const f = r[k] as Field<unknown> | undefined; if (f && !f.ok) n++; }));
    return n;
  }, [rows, date, fields]);
  const fieldsTotal = rows.length * fields.length + 1;

  function edit(i: number, k: Key, text: string) {
    setRows((prev) => {
      const next = [...prev];
      const r = { ...next[i] };
      let value: unknown = text;
      if (k === "vehicle") value = normalizeVehicle(text).value || text.toUpperCase().replace(/\s/g, "");
      else if (NUMERIC.includes(k)) value = text === "" ? null : Number(text.replace(",", "."));
      else if (LIST.includes(k)) value = text.split(/[^\d]+/).filter(Boolean);
      (r as Record<string, unknown>)[k] = { value, ok: true };
      if (k === "leadSeals") { const n = leadSealCount(value as string[]); r.sealCount = { value: n, ok: true, note: `${n} lead seals` }; }
      next[i] = r;
      return next;
    });
    setChanged((c) => new Set(c).add(`${i}.${String(k)}`));
  }
  function confirm(i: number, k: Key) {
    setRows((prev) => { const next = [...prev]; const r = { ...next[i] }; const f = r[k] as Field<unknown>; (r as Record<string, unknown>)[k] = { ...f, ok: true }; next[i] = r; return next; });
  }
  const addRow = () => setRows((p) => [...p, sealing
    ? { vehicle: { value: "", ok: false }, valveSeals: { value: [], ok: false }, leadSeals: { value: [], ok: false }, sealCount: { value: 0, ok: true }, cameraNo: { value: "", ok: false }, time: { value: "", ok: false } }
    : { vehicle: { value: "", ok: false }, tareMt: { value: null, ok: false }, grossMt: { value: null, ok: false }, netMt: { value: null, ok: false }, gpNo: { value: "", ok: false } }]);
  const removeRow = (i: number) => setRows((p) => p.filter((_, j) => j !== i));

  const header = (
    <View>
      <View style={s.rowBetween}>
        <Text style={s.h2}>{DOC_LABELS[ex.docType]}</Text>
        <Pressable onPress={onDebug}><Text style={s.link}>Debug</Text></Pressable>
      </View>
      <Text style={s.muted}>{rows.length} vehicle{rows.length === 1 ? "" : "s"} · read in {ex.ms ?? 0} ms · {ex.engine === "mlkit" ? "on phone" : "server AI"}</Text>
      {ex.warnings.map((w) => <Text key={w} style={s.warn}>{w}</Text>)}
      <FieldBox label="Date (YYYY-MM-DD)" f={date} onChange={(t) => { setDate({ value: t, ok: true }); setChanged((c) => new Set(c).add("date")); }} onConfirm={() => setDate({ ...date, ok: true })} />
    </View>
  );

  return (
    <View style={{ flex: 1 }}>
      <FlatList
        data={rows}
        keyExtractor={(_, i) => String(i)}
        ListHeaderComponent={header}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 12, paddingBottom: 120 }}
        renderItem={({ item: r, index: i }) => (
          <View style={s.card}>
            <View style={s.rowBetween}>
              <Text style={s.cardTitle}>#{i + 1} {r.vehicle.value || "—"}</Text>
              <Pressable onPress={() => removeRow(i)}><Text style={s.linkDanger}>Remove</Text></Pressable>
            </View>
            {fields.map(([k, label]) => {
              const f = r[k] as Field<unknown> | undefined;
              if (!f) return null;
              return <FieldBox key={k} label={label} f={f} numeric={NUMERIC.includes(k)} onChange={(t) => edit(i, k, t)} onConfirm={() => confirm(i, k)} />;
            })}
            {sealing && <Text style={s.muted}>Total lead seals: {r.sealCount?.value ?? 0}  ·  valve seals: {(r.valveSeals?.value ?? []).length}</Text>}
            {!sealing && <WeightCheck r={r} />}
          </View>
        )}
        ListFooterComponent={<Pressable style={s.btnGhost} onPress={addRow}><Text style={s.btnGhostText}>+ Add a vehicle the app missed</Text></Pressable>}
      />
      <View style={s.bottomBar}>
        <Pressable style={[s.btn, s.btnGrey]} onPress={onCancel}><Text style={s.btnText}>Cancel</Text></Pressable>
        <Pressable
          style={[s.btn, { flex: 2, backgroundColor: toCheck ? C.orange : C.green }]}
          disabled={toCheck > 0 || rows.length === 0}
          onPress={() => onSave({ date: date.value, docType: ex.docType, records: rows, changed: [...changed], fieldsTotal })}
        >
          <Text style={s.btnText}>{toCheck ? `${toCheck} to check` : `Save ${rows.length} vehicle${rows.length === 1 ? "" : "s"}`}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function FieldBox({ label, f, numeric, onChange, onConfirm }: { label: string; f: Field<unknown>; numeric?: boolean; onChange: (t: string) => void; onConfirm: () => void }) {
  const [text, setText] = useState(show(f));
  return (
    <View style={{ marginTop: 8 }}>
      <Text style={s.label}>{label}</Text>
      <View style={s.rowCenter}>
        <TextInput
          style={[s.input, !f.ok && s.inputCheck]}
          value={text}
          onChangeText={setText}
          onEndEditing={() => { if (text !== show(f)) onChange(text); }}
          keyboardType={numeric ? "decimal-pad" : "default"}
          autoCapitalize="characters"
          autoCorrect={false}
        />
        {!f.ok && <Pressable style={s.tick} onPress={onConfirm}><Text style={s.tickText}>✓</Text></Pressable>}
      </View>
      {!f.ok && f.note ? <Text style={s.note}>{f.note}</Text> : null}
    </View>
  );
}

function WeightCheck({ r }: { r: VehicleRecord }) {
  const g = r.grossMt?.value, t = r.tareMt?.value, n = r.netMt?.value;
  if (g == null || t == null || n == null) return null;
  const diff = Math.round((g - t - n) * 1000);
  return <Text style={diff === 0 ? s.ok : s.warn}>{diff === 0 ? "✓ Gross − Tare = Net" : `Gross − Tare − Net = ${diff} kg — check the weights`}</Text>;
}
