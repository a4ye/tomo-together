// Renders the Tomo Yard avatar sprites from hand-authored 20x20 ASCII pixel
// maps into 480x480 RGBA PNGs (24x nearest-neighbor upscale). Self-contained:
// a minimal PNG writer lives at the bottom, so no ImageMagick is needed.
//   node tools/generate-avatars.js
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const BASE = [
"....................",
"....................",
"....................",
"....................",
"......KKKKKKKK......",
".....KCCCCCCCCK.....",
"....KCHHCCCCCCCK....",
"...KCCHCCCCCCCCCK...",
"...KCCCCCCCCCCCCK...",
"...KCCEWCCCCEWCCK...",
"...KCCEECCCCEECCK...",
"...KBBCCCMMCCCBBK...",
"...KCCCCCCCCCCCCK...",
"...KSCCCCCCCCCCSK...",
"....KSCCCCCCCCSK....",
".....KSSSSSSSSK.....",
"......KKKKKKKK......",
"....................",
"....................",
"....................",
];

// species deltas: char overrides ("." keeps base)
const DELTA = {
  cat: {
    1: "......K......K......",
    2: ".....KPK....KPK.....",
    3: ".....KPPK..KPPK.....",
  },
  bear: {
    1: ".....KK......KK.....",
    2: "....KPPK....KPPK....",
    3: "....KCCK....KCCK....",
  },
  bunny: {
    0: ".....KK......KK.....",
    1: "....KPPK....KPPK....",
    2: "....KPPK....KPPK....",
    3: "....KCCK....KCCK....",
  },
  frog: {
    2: ".....KK......KK.....",
    3: "....KCCK....KCCK....",
    11: "...KBBCMMMMMMCBBK...",
  },
  duck: {
    2: "...........K........",
    3: "..........K.........",
    11: "...KBBCCOOOOCCBBK...",
  },
};

const ACC = {
  // ---- headwear ----
  party_hat: {
    0: ".........WW.........",
    1: "........KPPK........",
    2: ".......KPPPPK.......",
    3: "......KPPPPPPK......",
    4: ".....KPPPPPPPPK.....",
  },
  beanie: {
    1: ".........WW.........",
    2: "......KKKKKKKK......",
    3: ".....KLLLLLLLLK.....",
    4: "....KLLLLLLLLLLK....",
    5: "....KKKKKKKKKKKK....",
  },
  flower_crown: {
    3: ".....PP.YY.PP.YY....",
    4: "....G..G..G..G..G...",
  },
  crown: {
    1: ".....Y..Y..Y..Y.....",
    2: ".....YYYYYYYYYY.....",
    3: ".....YYYYYYYYYY.....",
    4: ".....KKKKKKKKKK.....",
  },
  wizard_hat: {
    0: ".........KK.........",
    1: "........KUUK........",
    2: "........KUYK........",
    3: ".......KUUUUK.......",
    4: "......KUUYUUYK......",
    5: "...KUUUUUUUUUUUUK...",
  },
  cowboy_hat: {
    1: ".......KKKKKK.......",
    2: "......KTTTTTTK......",
    3: "......KTDDDDTK......",
    4: "..KTTTTTTTTTTTTTTK..",
    5: "...KKKKKKKKKKKKKK...",
  },
  chef_hat: {
    0: "....KKKKKKKKKKKK....",
    1: "...KWWWWWWWWWWWWK...",
    2: "...KWWWWWWWWWWWWK...",
    3: "....KWWWWWWWWWWK....",
    4: ".....KWWWWWWWWK.....",
    5: ".....KKKKKKKKKK.....",
  },
  halo: {
    0: "........YYYY........",
    1: ".......Y....Y.......",
    2: "........YYYY........",
  },
  cat_ears: {
    1: "...KK..........KK...",
    2: "..KPPK........KPPK..",
    3: "..KPPK........KPPK..",
    4: "....KKKKKKKKKKKK....",
  },
  propeller_cap: {
    0: "......RRRKYYY.......",
    1: ".........K..........",
    2: "......KKKKKKKK......",
    3: ".....KRRYYRRYYK.....",
    4: "....KYYRRYYRRYYK....",
    5: "....KKKKKKKKKKKK....",
  },
  viking_helm: {
    2: "..KK............KK..",
    3: ".KWWKKKKKKKKKKKKWWK.",
    4: ".KWWKAAAAAAAAAAKWWK.",
    5: "..KKKAYAAAAAAYAKKK..",
    6: "....KKKKKKKKKKKK....",
  },
  // ---- eyewear ----
  round_glasses: {
    8: "....KKKKK..KKKKK....",
    9: "....K...KKKK...K....",
    10: "....K...K..K...K....",
    11: "....KKKKK..KKKKK....",
  },
  star_glasses: {
    8: "......Y......Y......",
    9: ".....YYY.YY.YYY.....",
    10: "......Y......Y......",
  },
  sunglasses: {
    9: ".....KKKKKKKKKK.....",
    10: ".....KKKK..KKKK.....",
  },
  monocle: {
    8: "............YY......",
    9: "...........Y..Y.....",
    10: "...........Y..Y.....",
    11: "............YY......",
    12: "..............Y.....",
    13: "...............Y....",
  },
  eyepatch: {
    8: "....KKKKKKKKKKKK....",
    9: "...........KKKK.....",
    10: "...........KKKK.....",
    11: "............KK......",
  },
  heart_glasses: {
    8: "....PP.PP..PP.PP....",
    9: "....PPPPPKKPPPPP....",
    10: ".....PPP....PPP.....",
    11: "......P......P......",
  },
  ski_goggles: {
    6: "....LLLLLLLLLLLL....",
    7: "...KKKKKKKKKKKKKK...",
    8: "...KIWWIIIIIIIIIK...",
    9: "...KIIIIIIIIIIIIK...",
    10: "...KKKKKKKKKKKKKK...",
  },
  // ---- neck ----
  scarf: {
    14: "....OOOOOOOOOOOO....",
    15: ".....DDDDDDDDDD.....",
    16: "..........OO........",
    17: "..........OO........",
  },
  bowtie: {
    13: "......RR....RR......",
    14: "......RRRWWRRR......",
    15: "......RR....RR......",
  },
  bandana: {
    14: "....RRRRRRRRRRRR....",
    15: ".....RRRWRRWRRR.....",
    16: "......RRRRRRRR......",
    17: ".......RRRRRR.......",
    18: ".........RR.........",
  },
  bell_collar: {
    14: "....DDDDDDDDDDDD....",
    15: ".........YY.........",
    16: "........YYYY........",
    17: ".........KK.........",
  },
  bow_ribbon: {
    13: "....PPP......PPP....",
    14: "....PPPPPWWPPPPP....",
    15: "....PPPPPWWPPPPP....",
    16: "....PPP......PPP....",
  },
};

const COLORS = ["#A8D8C8", "#F5B8A0", "#C9B8E8", "#A0C8E8", "#F0D890", "#F0B8D0"];
const FIXED = {
  K: "#4A4031", E: "#4A4031", M: "#4A4031", W: "#FFFFFF",
  B: "#F2A7B3", P: "#F0A8C0", Y: "#F0C93F", L: "#7FA8D8",
  O: "#E08A5A", D: "#C96F42", R: "#D86A6A", G: "#83C167",
  U: "#7B5EA7", T: "#C89A62", A: "#9DA6B0", I: "#7FDCE8",
};
const hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const rgb2hex = (r) => "#" + r.map((v) => v.toString(16).padStart(2, "0")).join("");

const GRID = 20;   // source map size
const SCALE = 24;  // nearest-neighbor upscale -> 480x480

// ---- minimal PNG writer (RGBA8, filter 0 on every scanline) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function pngEncode(rgba, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  // ihdr[10..12] = 0: deflate, no filter heuristics, no interlace
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- rasterize a 20x20 map and write the upscaled sprite ----
function render(rows, colorHex, file) {
  const C = hex2rgb(colorHex);
  const S = mix(C, [58, 48, 37], 0.25);
  const H = mix(C, [255, 255, 255], 0.45);
  const small = Buffer.alloc(GRID * GRID * 4); // transparent (0,0,0,0)
  rows.forEach((row, y) => {
    if (row.length !== GRID) throw new Error(`row ${y} len ${row.length} in ${file}`);
    [...row].forEach((ch, x) => {
      if (ch === ".") return;
      let rgb;
      if (ch === "C") rgb = C;
      else if (ch === "S") rgb = S;
      else if (ch === "H") rgb = H;
      else if (FIXED[ch]) rgb = hex2rgb(FIXED[ch]);
      else throw new Error(`bad char ${ch} at ${x},${y} in ${file}`);
      const o = (y * GRID + x) * 4;
      small[o] = rgb[0]; small[o + 1] = rgb[1]; small[o + 2] = rgb[2]; small[o + 3] = 255;
    });
  });
  const W = GRID * SCALE;
  const big = Buffer.alloc(W * W * 4);
  for (let y = 0; y < W; y++) {
    const sy = (y / SCALE) | 0;
    for (let x = 0; x < W; x++) {
      const so = ((sy * GRID) + ((x / SCALE) | 0)) * 4;
      small.copy(big, (y * W + x) * 4, so, so + 4);
    }
  }
  fs.writeFileSync(file, pngEncode(big, W, W));
}

function merged(delta) {
  return BASE.map((row, y) => {
    const d = delta[y];
    if (!d) return row;
    return [...row].map((ch, x) => (d[x] === "." ? ch : d[x])).join("");
  });
}

const OUT = path.join(__dirname, "..", "assets", "avatar");
fs.mkdirSync(OUT, { recursive: true });
let n = 0;
for (const [sp, delta] of Object.entries(DELTA)) {
  const rows = merged(delta);
  COLORS.forEach((c, i) => {
    render(rows, c, path.join(OUT, `${sp}_${i}.png`));
    n++;
  });
}
const EMPTY = BASE.map(() => "....................");
for (const [k, delta] of Object.entries(ACC)) {
  const rows = EMPTY.map((row, y) => delta[y] ?? row);
  render(rows, "#000000", path.join(OUT, `acc_${k}.png`));
  n++;
}
console.log(`all sprites authored: ${n} PNGs -> ${OUT}`);
