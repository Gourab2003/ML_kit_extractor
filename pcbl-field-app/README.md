# PCBL Field — prototype

An Android app for loading-site staff: **photograph a challan → the form fills itself → staff check the highlighted fields → save**.
It works with no signal (saved on the phone, sent later). One sealing challan with 10–20 vehicles fills 10–20 rows in one go.

```
app/        Expo (React Native + TypeScript) app
  src/engine/   the reading rules: OCR text -> rows (shared with the server, with tests)
  src/ocr.ts    Google ML Kit on the phone, auto-rotates sideways photos
  src/Review.tsx  the check-and-confirm form
server/     small Node service: AI reading (Claude) + receives submissions
.github/workflows/  APK build (GitHub's machines) + server deploy (automation server)
```

## Two reading engines (switch in Settings)

| | On phone (ML Kit) | Server AI (Claude) |
|---|---|---|
| Data used | **none** | one photo, ~150–250 KB |
| Speed | ~0.3–1.5 s | ~5–15 s |
| Printed slips (Aegis, Ruchi, AVR, HPL) | good | very good |
| **Handwritten sealing challans** | weak: expect many orange fields | much better |
| Works offline | yes | no (falls back to phone) |

The point of the prototype is to **measure** this on real challans. The app's **Test results** screen shows, per document type, how many fields the app filled correctly vs how many staff had to change.

**Orange field** = the app is not sure (bad read, plate didn't look valid, Gross − Tare ≠ Net, a duplicate vehicle…). Staff fix it or tap ✓. **Save stays locked until nothing is orange.** That's what stops wrong data from going in.

---

## 1. Get the APK (no Android Studio needed)

1. Create a private repo `XCONICS-ORG/pcbl-field-app`, push this folder.
2. GitHub → **Actions** → *Build Android APK* runs on its own (~10–15 min). Or press **Run workflow**.
3. Open the finished run → **Artifacts** → `pcbl-field-apk` → unzip → `pcbl-field-<sha>.apk`.
4. Copy it to the phone (WhatsApp/Drive/USB), open it, allow "install unknown apps". Android 7+.

The first launch opens **Settings**: name, site, engine. Leave *Server address* empty to test ML Kit only.

## 2. Server (only needed for the "Server AI" engine and to collect submissions)

On the automation server (the GitHub runner from the mail reader is reused):

```bash
mkdir -p /etc/pcbl-field
cat > /etc/pcbl-field/server.env <<EOF
API_KEY=$(openssl rand -hex 24)
ANTHROPIC_API_KEY=<key from console.anthropic.com, company account>
ANTHROPIC_MODEL=claude-sonnet-5-5
EOF
chown root:gha-runner /etc/pcbl-field/server.env && chmod 640 /etc/pcbl-field/server.env
grep API_KEY= /etc/pcbl-field/server.env    # put this key in the app's Settings
```

Push to `main` → *Deploy field server* builds, tests and starts it (port 8090, data kept in Docker volume `pcbl-field-data`).

**Phones must reach it over the internet.** It listens on `127.0.0.1:8090` by default. Pick one:
- **Recommended:** Cloudflare Tunnel or nginx + certbot on a subdomain (e.g. `https://field.xconics.com` → `127.0.0.1:8090`). HTTPS, no open ports with the tunnel.
- **Quick office test only:** in the workflow run, set `BIND=0.0.0.0`, open port 8090, use `http://<server-ip>:8090`. Photos and the key travel unencrypted, so don't leave it like this.

Check it: `curl -s http://127.0.0.1:8090/healthz` · see what arrived: `curl -s -H "x-api-key: $KEY" http://127.0.0.1:8090/submissions`

## 3. Test plan (do this yourself before giving it to site staff)

For **each** type, test **both engines**, with **good** photos (flat, full page, daylight) and **realistic** ones (at an angle, WhatsApp-forwarded):

| # | Document | Expect |
|---|---|---|
| 1 | Aegis sealing challan (20 rows) | 20 rows; seals counted (225,212,212 → 10) |
| 2 | Ruchi sealing challan | 15 rows |
| 3 | AVR / HPL sealing challan | all rows; HPL plates are GJ… |
| 4 | Aegis gate pass (photo of the printed GP) | weights in MT, GP no., challan no. |
| 5 | Ruchi weighbridge slip (sideways print) | auto-rotated; kg → MT; first weight = tare |
| 6 | AVR gate pass (dot-matrix) | MT, GP no. |
| 7 | HPL bill of lading | kg → MT, order no. |

After each one: correct what's wrong, save. Then open **Test results**.

**When something reads badly, send it back to us:** on the form, tap **Debug → Export OCR** and send that text along with the photo. That's real ML Kit output; it becomes a test case and the reading rules get tuned against it.

## Developing

```bash
cd app && npm ci
npm test              # reading engine tests (Node 22.18+)
npx tsc --noEmit      # typecheck
npx expo run:android  # needs Android Studio / a phone with USB debugging
```

## Known limits (prototype)

- Site is chosen in Settings, not by login. No user accounts yet.
- Handwriting with ML Kit will need correcting; that's what this test measures.
- Submissions go to this prototype server, not the MIS yet.
- Release APK is signed with a debug key: fine for testing, not for the Play Store.
