// PCBL field app (prototype): photo of a challan -> form filled in -> staff check -> saved on phone -> sent when online.
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Share, Text, TextInput, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import * as ImagePicker from "expo-image-picker";
import * as Haptics from "expo-haptics";
import { extract, DOC_LABELS, type DocType, type Extraction, type OcrLine } from "./src/engine/index.ts";
import { prepare, readImage } from "./src/ocr.ts";
import { loadSettings, saveSettings, saveSubmission, sync, pending, history, readOnServer, SITES, type Settings, type Submission } from "./src/store.ts";
import { Review, type ReviewResult } from "./src/Review.tsx";
import { s, C } from "./src/styles.ts";

type Screen = "home" | "reading" | "review" | "settings" | "debug" | "stats";
interface Current { ex: Extraction; lines: OcrLine[]; rotation: number; photoUri: string }

const TYPES: DocType[] = ["sealing", "aegis_gp", "ruchi_slip", "avr_gp", "hpl_bol"];

export default function App() {
  const [screen, setScreen] = useState<Screen>("home");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [cur, setCur] = useState<Current | null>(null);
  const [status, setStatus] = useState("");
  const [waiting, setWaiting] = useState(0);

  const refresh = useCallback(() => setWaiting(pending().length), []);
  useEffect(() => { loadSettings().then((st) => { setSettings(st); if (!st.staff) setScreen("settings"); }); refresh(); }, [refresh]);
  useEffect(() => {
    if (!settings) return;
    const t = setInterval(() => sync(settings).then((r) => { if (r.sent) refresh(); }), 30000);
    return () => clearInterval(t);
  }, [settings, refresh]);

  if (!settings) return <View style={[s.screen, { justifyContent: "center" }]}><ActivityIndicator size="large" /></View>;

  async function scan(from: "camera" | "gallery") {
    const perm = from === "camera" ? await ImagePicker.requestCameraPermissionsAsync() : { granted: true };
    if (!perm.granted) return Alert.alert("Camera permission is needed");
    const pick = from === "camera"
      ? await ImagePicker.launchCameraAsync({ mediaTypes: "images", quality: 1 })
      : await ImagePicker.launchImageLibraryAsync({ mediaTypes: "images", quality: 1 });
    if (pick.canceled || !pick.assets?.[0]) return;
    setScreen("reading");
    try {
      setStatus("Preparing photo…");
      const img = await prepare(pick.assets[0].uri, 2000, 0.8);
      let ex: Extraction, lines: OcrLine[] = [], rotation = 0;
      if (settings!.engine === "server") {
        setStatus("Reading on server…");
        const t0 = Date.now();
        try {
          const small = await prepare(img.uri, 1600, 0.6);
          ex = await readOnServer(settings!, small.uri);
          ex.ms = Date.now() - t0;
        } catch (e) {
          setStatus("Server not reachable - reading on phone…");
          const r = await readImage(img.uri);
          lines = r.lines; rotation = r.rotation;
          ex = { ...extract(lines), ms: r.ms };
          ex.warnings.unshift(`Server failed (${(e as Error).message}), read on phone instead.`);
        }
      } else {
        setStatus("Reading on phone…");
        const r = await readImage(img.uri);
        lines = r.lines; rotation = r.rotation;
        const t1 = Date.now();
        ex = extract(lines);
        ex.ms = r.ms + (Date.now() - t1);
      }
      setCur({ ex, lines, rotation, photoUri: img.uri });
      Haptics.notificationAsync(ex.toCheck ? Haptics.NotificationFeedbackType.Warning : Haptics.NotificationFeedbackType.Success);
      setScreen("review");
    } catch (e) {
      Alert.alert("Could not read the photo", (e as Error).message);
      setScreen("home");
    }
  }

  function retype(t: DocType) {
    if (!cur || !cur.lines.length) return;
    const ex = { ...extract(cur.lines, t), ms: cur.ex.ms };
    setCur({ ...cur, ex });
  }

  async function save(r: ReviewResult) {
    if (!cur) return;
    const sub: Submission = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      createdAt: new Date().toISOString(),
      site: settings!.site, staff: settings!.staff,
      docType: r.docType, date: r.date, engine: cur.ex.engine,
      readMs: cur.ex.ms ?? 0, rotation: cur.rotation,
      original: cur.ex, records: r.records, changed: r.changed, fieldsTotal: r.fieldsTotal,
      photo: "photo.jpg",
    };
    try { await saveSubmission(sub, cur.photoUri); }
    catch (e) { return Alert.alert("Could not save", (e as Error).message); }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setCur(null);
    setScreen("home");
    refresh();
    sync(settings!).then(refresh);
  }

  // ---------- screens ----------
  if (screen === "reading") return (
    <View style={[s.screen, { justifyContent: "center", alignItems: "center" }]}>
      <ActivityIndicator size="large" color={C.blue} />
      <Text style={[s.muted, { marginTop: 12 }]}>{status}</Text>
    </View>
  );

  if (screen === "review" && cur) return (
    <View style={[s.screen, { paddingTop: 36 }]}>
      <StatusBar style="dark" />
      {(cur.ex.docType === "unknown" || cur.lines.length > 0) && (
        <ScrollView horizontal style={{ maxHeight: 52, paddingHorizontal: 12 }} showsHorizontalScrollIndicator={false}>
          <Text style={[s.muted, { marginTop: 16, marginRight: 6 }]}>Read as:</Text>
          {TYPES.map((t) => (
            <Pressable key={t} style={[s.chip, cur.ex.docType === t && s.chipOn]} onPress={() => retype(t)}>
              <Text style={cur.ex.docType === t ? s.chipTextOn : s.chipText}>{DOC_LABELS[t]}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
      <Review key={cur.ex.docType} ex={cur.ex} onSave={save} onCancel={() => { setCur(null); setScreen("home"); }} onDebug={() => setScreen("debug")} />
    </View>
  );

  if (screen === "debug" && cur) {
    const dump = JSON.stringify({ rotation: cur.rotation, lines: cur.lines, extraction: cur.ex }, null, 1);
    return (
      <View style={[s.screen, { paddingTop: 36 }]}>
        <View style={[s.rowBetween, s.pad]}>
          <Pressable onPress={() => setScreen("review")}><Text style={s.link}>‹ Back</Text></Pressable>
          <Pressable onPress={() => Share.share({ message: dump, title: "PCBL OCR debug" })}><Text style={s.link}>Export OCR</Text></Pressable>
        </View>
        <ScrollView style={s.pad}>
          <Text style={s.muted}>{cur.lines.length} lines · rotated {cur.rotation}°</Text>
          {cur.lines.map((l, i) => <Text key={i} style={s.mono}>{`${Math.round(l.box.left)},${Math.round(l.box.top)}  ${l.text}`}</Text>)}
        </ScrollView>
      </View>
    );
  }

  if (screen === "settings") return <SettingsScreen initial={settings} onDone={(st) => { saveSettings(st); setSettings(st); setScreen("home"); }} />;

  if (screen === "stats") return <Stats onBack={() => setScreen("home")} />;

  return (
    <View style={[s.screen, s.pad, { paddingTop: 48 }]}>
      <StatusBar style="dark" />
      <View style={s.rowBetween}>
        <View>
          <Text style={s.h1}>PCBL Field</Text>
          <Text style={s.muted}>{settings.site} · {settings.staff || "—"} · {settings.engine === "mlkit" ? "reads on phone" : "reads on server"}</Text>
        </View>
        <Pressable onPress={() => setScreen("settings")}><Text style={s.link}>Settings</Text></Pressable>
      </View>

      <Pressable style={s.btnBig} onPress={() => scan("camera")}><Text style={[s.btnText, { fontSize: 20 }]}>📷  Scan challan</Text></Pressable>
      <Pressable style={s.btnGhost} onPress={() => scan("gallery")}><Text style={s.btnGhostText}>Pick photo from gallery / WhatsApp</Text></Pressable>

      <View style={[s.card, { marginTop: 24 }]}>
        <Text style={s.cardTitle}>{waiting ? `${waiting} waiting to send` : "Everything sent"}</Text>
        <Text style={s.muted}>{settings.serverUrl ? "Sends automatically when there is internet." : "No server set - saved on this phone only."}</Text>
        {waiting > 0 && settings.serverUrl ? (
          <Pressable style={s.btnGhost} onPress={async () => { const r = await sync(settings); refresh(); Alert.alert(r.error ? "Not sent" : "Sent", r.error ?? `${r.sent} sent`); }}>
            <Text style={s.btnGhostText}>Send now</Text>
          </Pressable>
        ) : null}
      </View>
      <Pressable style={s.btnGhost} onPress={() => setScreen("stats")}><Text style={s.btnGhostText}>Test results</Text></Pressable>
    </View>
  );
}

function SettingsScreen({ initial, onDone }: { initial: Settings; onDone: (s: Settings) => void }) {
  const [st, setSt] = useState(initial);
  const set = (k: keyof Settings) => (v: string) => setSt({ ...st, [k]: v });
  return (
    <ScrollView style={[s.screen, s.pad]} contentContainerStyle={{ paddingTop: 36, paddingBottom: 60 }}>
      <Text style={s.h1}>Settings</Text>
      <Text style={[s.label, { marginTop: 16 }]}>Your name</Text>
      <TextInput style={s.input} value={st.staff} onChangeText={set("staff")} placeholder="Name" />
      <Text style={[s.label, { marginTop: 16 }]}>Site</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
        {SITES.map((x) => <Pressable key={x} style={[s.chip, st.site === x && s.chipOn]} onPress={() => setSt({ ...st, site: x })}><Text style={st.site === x ? s.chipTextOn : s.chipText}>{x}</Text></Pressable>)}
      </View>
      <Text style={[s.label, { marginTop: 16 }]}>Reading engine</Text>
      <View style={{ flexDirection: "row" }}>
        {(["mlkit", "server"] as const).map((x) => (
          <Pressable key={x} style={[s.chip, st.engine === x && s.chipOn]} onPress={() => setSt({ ...st, engine: x })}>
            <Text style={st.engine === x ? s.chipTextOn : s.chipText}>{x === "mlkit" ? "On phone (ML Kit, no data)" : "Server AI (~200 KB/photo)"}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={[s.label, { marginTop: 16 }]}>Server address (leave empty to keep everything on this phone)</Text>
      <TextInput style={s.input} value={st.serverUrl} onChangeText={set("serverUrl")} placeholder="https://..." autoCapitalize="none" keyboardType="url" />
      <Text style={[s.label, { marginTop: 16 }]}>Server key</Text>
      <TextInput style={s.input} value={st.apiKey} onChangeText={set("apiKey")} autoCapitalize="none" secureTextEntry />
      <Pressable style={s.btnBig} onPress={() => (st.staff.trim() ? onDone({ ...st, staff: st.staff.trim() }) : Alert.alert("Enter your name"))}>
        <Text style={s.btnText}>Save</Text>
      </Pressable>
    </ScrollView>
  );
}

/** How well did the app fill the forms? (fields the staff had to change / all fields) */
function Stats({ onBack }: { onBack: () => void }) {
  const all = history();
  const by = new Map<string, { docs: number; vehicles: number; fields: number; changed: number; ms: number; engine: Set<string> }>();
  for (const x of all) {
    const k = DOC_LABELS[x.docType];
    const v = by.get(k) ?? { docs: 0, vehicles: 0, fields: 0, changed: 0, ms: 0, engine: new Set() };
    v.docs++; v.vehicles += x.records.length; v.fields += x.fieldsTotal; v.changed += x.changed.length; v.ms += x.readMs; v.engine.add(x.engine);
    by.set(k, v);
  }
  return (
    <ScrollView style={[s.screen, s.pad]} contentContainerStyle={{ paddingTop: 36, paddingBottom: 60 }}>
      <Pressable onPress={onBack}><Text style={s.link}>‹ Back</Text></Pressable>
      <Text style={s.h1}>Test results</Text>
      <Text style={s.muted}>Accuracy = fields filled correctly by the app (not changed by staff) / all fields.</Text>
      {[...by.entries()].map(([k, v]) => (
        <View key={k} style={s.card}>
          <Text style={s.cardTitle}>{k}</Text>
          <Text>{v.docs} challans · {v.vehicles} vehicles · {[...v.engine].join(" + ")}</Text>
          <Text style={{ fontSize: 20, fontWeight: "700", color: v.changed ? C.orange : C.green }}>
            {v.fields ? Math.round((1 - v.changed / v.fields) * 100) : 0}% filled correctly
          </Text>
          <Text style={s.muted}>{v.changed} of {v.fields} fields corrected · avg read {Math.round(v.ms / v.docs)} ms</Text>
        </View>
      ))}
      {!all.length && <Text style={s.muted}>No challans saved yet.</Text>}
    </ScrollView>
  );
}
