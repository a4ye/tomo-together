// Minimal Extended-JSON (canonical/relaxed mix) decoder for the Atlas export.
//
// The export in ht6-atlas-export/ was produced with EJSON.stringify, so numbers
// arrive as {"$numberInt":"14"} / {"$numberDouble":"85.5"} / {"$numberLong":"…"},
// ObjectIds as {"$oid":"…"} and Dates as {"$date":{"$numberLong":"…"}}.
//
// Everything the export actually contains is representable losslessly as a JS
// value: every $numberLong here is a millisecond timestamp well inside 2^53.
// An out-of-range long throws rather than silently rounding.

import { readFileSync } from 'node:fs';

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

export class MongoDate {
  constructor(ms) {
    this.ms = ms;
  }
}
export class ObjectId {
  constructor(hex) {
    this.hex = hex;
  }
}

function longToNumber(raw, where) {
  const asBig = BigInt(raw);
  if (asBig > MAX_SAFE || asBig < -MAX_SAFE) {
    throw new RangeError(`$numberLong ${raw} at ${where} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return Number(asBig);
}

export function fromEJSON(value, where = '$') {
  if (Array.isArray(value)) return value.map((v, i) => fromEJSON(v, `${where}[${i}]`));
  if (value === null || typeof value !== 'object') return value;

  const keys = Object.keys(value);
  if (keys.length === 1) {
    const [k] = keys;
    if (k === '$numberInt') return Number(value[k]);
    if (k === '$numberDouble') return Number(value[k]);
    if (k === '$numberLong') return longToNumber(value[k], where);
    if (k === '$oid') return new ObjectId(value[k]);
    if (k === '$date') {
      const inner = value[k];
      if (typeof inner === 'string') return new MongoDate(Date.parse(inner));
      return new MongoDate(longToNumber(inner.$numberLong, `${where}.$date`));
    }
    if (k === '$numberDecimal') return value[k];
    if (k.startsWith('$')) throw new TypeError(`unsupported EJSON wrapper ${k} at ${where}`);
  }

  const out = {};
  for (const k of keys) out[k] = fromEJSON(value[k], `${where}.${k}`);
  return out;
}

/** Read one exported collection file into an array of plain documents. */
export function readCollection(file) {
  const raw = readFileSync(file, 'utf8');
  if (raw.trim() === '') return [];
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line, i) => fromEJSON(JSON.parse(line), `${file}:${i + 1}`));
}
