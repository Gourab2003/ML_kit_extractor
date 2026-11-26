// Shared shapes for the challan reading engine.
// Used by the app (ML Kit results) and by the server (AI results), so both fill the form the same way.

/** A box on the image, in pixels. */
export interface Box { left: number; top: number; right: number; bottom: number }

/** One piece of recognised text (ML Kit "element" = word, or "line"). */
export interface OcrWord { text: string; box: Box }
export interface OcrLine { text: string; box: Box; words: OcrWord[] }

export type DocType = "sealing" | "aegis_gp" | "ruchi_slip" | "avr_gp" | "hpl_bol" | "unknown";

export const DOC_LABELS: Record<DocType, string> = {
  sealing: "Sealing challan",
  aegis_gp: "Aegis gate pass",
  ruchi_slip: "Ruchi weighbridge slip",
  avr_gp: "AVR gate pass",
  hpl_bol: "HPL bill of lading",
  unknown: "Unknown document",
};

/** A field the app shows for checking. ok=false means "please check this" (highlighted in the form). */
export interface Field<T> { value: T; ok: boolean; note?: string }

/** One vehicle read from a challan. A sealing challan gives many; a weight slip gives one. */
export interface VehicleRecord {
  vehicle: Field<string>;
  // sealing challan
  valveSeals?: Field<string[]>;
  leadSeals?: Field<string[]>;
  sealCount?: Field<number>;
  cameraNo?: Field<string>;
  time?: Field<string>;
  // weight slip / gate pass (always in MT)
  tareMt?: Field<number | null>;
  grossMt?: Field<number | null>;
  netMt?: Field<number | null>;
  gpNo?: Field<string>;
  challanNo?: Field<string>;
  weighedAt?: Field<string>; // "YYYY-MM-DD HH:mm" (local) when known
}

export interface Extraction {
  docType: DocType;
  date: Field<string>; // YYYY-MM-DD
  records: VehicleRecord[];
  /** How many fields need checking across all records. 0 = everything looked right. */
  toCheck: number;
  engine: "mlkit" | "server";
  ms?: number;
  warnings: string[];
}
