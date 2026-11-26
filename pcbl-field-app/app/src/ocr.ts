// On-device reading with Google ML Kit (no internet needed).
// Photos of challans are often sideways (Ruchi slips are printed rotated), so if the first read
// doesn't look like a known document, the image is turned 90/270/180 degrees and read again.
import { recognizeText } from "@infinitered/react-native-mlkit-text-recognition";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { detectType, type OcrLine } from "./engine/index.ts";

export interface OcrRun { lines: OcrLine[]; rotation: number; ms: number; imageUri: string }

async function readOnce(uri: string): Promise<OcrLine[]> {
  const res = await recognizeText(uri);
  return res.blocks.flatMap((b) =>
    b.lines.map((l) => ({
      text: l.text,
      box: { ...l.frame },
      words: l.elements.map((e) => ({ text: e.text, box: { ...e.frame } })),
    })),
  );
}

async function rotated(uri: string, degrees: number): Promise<string> {
  const img = await ImageManipulator.manipulate(uri).rotate(degrees).renderAsync();
  const out = await img.saveAsync({ format: SaveFormat.JPEG, compress: 0.9 });
  return out.uri;
}

/** Shrink big camera photos: ML Kit is faster on ~2000 px and just as accurate. Also the copy we upload. */
export async function prepare(uri: string, maxSide = 2000, compress = 0.8): Promise<{ uri: string; width: number; height: number }> {
  const ctx = ImageManipulator.manipulate(uri);
  const probe = await ctx.renderAsync();
  const { width, height } = probe;
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const img = scale < 1 ? await ImageManipulator.manipulate(uri).resize({ width: Math.round(width * scale) }).renderAsync() : probe;
  const out = await img.saveAsync({ format: SaveFormat.JPEG, compress });
  return { uri: out.uri, width: out.width, height: out.height };
}

export async function readImage(uri: string): Promise<OcrRun> {
  const t0 = Date.now();
  const score = (ls: OcrLine[]) => detectType(ls).score * 1000 + ls.length;
  let best: OcrRun = { lines: await readOnce(uri), rotation: 0, ms: 0, imageUri: uri };
  if (detectType(best.lines).type === "unknown") {
    for (const deg of [90, 270, 180]) {
      const rUri = await rotated(uri, deg);
      const lines = await readOnce(rUri);
      if (score(lines) > score(best.lines)) best = { lines, rotation: deg, ms: 0, imageUri: rUri };
      if (detectType(lines).type !== "unknown") break;
    }
  }
  best.ms = Date.now() - t0;
  return best;
}
