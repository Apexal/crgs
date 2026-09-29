// Generates the pixel jack o' lantern cursors in public/assets/cursors/. Run: node scripts/cursors.mjs
// Each cursor is a 16x16 map drawn at 32x32. Legend: k outline, o body, d ridge, g stem, f face, h hot face core, w bone.
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = new URL('../public/assets/cursors/', import.meta.url);

const COLORS = {
  ink: '#0E0A14', bone: '#FFFBF1',
  pumpkin: '#E8804A', pumpkinDark: '#B0542A', pumpkinBright: '#EE8C52', pumpkinMid: '#C0602F',
  rot: '#9A6A4A', rotDark: '#6E4630', rotStem: '#4A3860',
  stem: '#5E8A2A', stemBright: '#A8D65E', glow: '#F7DC6A',
};
const IDLE = { k: COLORS.ink, o: COLORS.pumpkin, d: COLORS.pumpkinDark, g: COLORS.stem, f: COLORS.ink };
const LIT = { k: COLORS.ink, o: COLORS.pumpkinBright, d: COLORS.pumpkinMid, g: COLORS.stemBright, f: COLORS.glow, h: COLORS.bone };

const BODY = [
  '......kkkk......',
  '......kggk......',
  '...kkkkggkkkk...',
  '..koodoooodook..',
  '.kooodoooodoook.',
  'kooooooooooooook',
  'kooooooooooooook',
  'kooooooooooooook',
  'kooooooooooooook',
  'kooooooooooooook',
  'kooooooooooooook',
  'kooooooooooooook',
  '.kooooooooooook.',
  '..koodoooodook..',
  '...kkkkkkkkkk...',
  '................',
];

// Paint [x, y, char] pixels over the body. Faces are symmetric, so each helper mirrors x -> 15 - x.
const mirror = px => px.flatMap(([x, y, c]) => [[x, y, c], [15 - x, y, c]]);
const row = (y, x0, x1, c = 'f') => Array.from({ length: x1 - x0 + 1 }, (_, i) => [x0 + i, y, c]);
const paint = (base, px) => {
  const grid = base.map(r => [...r]);
  for (const [x, y, c] of px) grid[y][x] = c;
  return grid.map(r => r.join(''));
};

const FACES = {
  // Classic triangle eyes, nose, toothy smile.
  jack: [
    ...mirror([[4, 6, 'f'], ...row(7, 3, 5), [7, 8, 'f'], [3, 9, 'f']]),
    ...row(10, 3, 12), [6, 10, 'o'], [9, 10, 'o'],
    ...mirror(row(11, 4, 6)),
  ],
  // Happy crescent eyes and a wide open grin, for things you can click.
  grin: [
    ...mirror([[4, 6, 'f'], [3, 7, 'f'], [5, 7, 'f']]),
    ...row(9, 3, 12), [5, 9, 'o'], [10, 9, 'o'],
    ...row(10, 3, 12),
    ...row(11, 5, 10), [7, 11, 'o'], [8, 11, 'o'],
  ],
  // X eyes and a frown, for disabled controls.
  no: [
    ...mirror([[3, 5, 'f'], [5, 5, 'f'], [4, 6, 'f'], [3, 7, 'f'], [5, 7, 'f']]),
    ...row(10, 5, 10),
    ...mirror([[4, 11, 'f']]),
  ],
  // Closed eyes and a yawn, for busy controls.
  wait: [
    ...mirror(row(7, 3, 5)),
    ...row(10, 7, 8), ...row(11, 7, 8),
  ],
};
const HOT = { jack: [[4, 7], [11, 7], [7, 8], [8, 8]], grin: row(10, 6, 9).map(([x, y]) => [x, y]) };

const TEXT = [
  '.......kk.......',
  '......kggk......',
  '....kkkkkkkk....',
  '...kooooooook...',
  '...kofoooofok...',
  '...kooffffook...',
  '....kkkwwkkk....',
  '......kwwk......',
  '......kwwk......',
  '......kwwk......',
  '......kwwk......',
  '......kwwk......',
  '......kwwk......',
  '....kkkwwkkk....',
  '....kwwwwwwk....',
  '....kkkkkkkk....',
];

const svg = (map, pal) => {
  map.forEach((r, i) => { if (r.length !== 16) throw new Error(`row ${i} is ${r.length} wide`); });
  let rects = '';
  map.forEach((r, y) => [...r].forEach((c, x) => {
    if (pal[c]) rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="${pal[c]}"/>`;
  }));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 16 16" shape-rendering="crispEdges">${rects}</svg>\n`;
};

const withHot = (face, name) => [...face, ...(HOT[name] ?? []).map(([x, y]) => [x, y, 'h'])];
const ROT = { k: COLORS.ink, o: COLORS.rot, d: COLORS.rotDark, g: COLORS.rotStem, f: COLORS.ink };

const cursors = {
  'jack': svg(paint(BODY, FACES.jack), IDLE),
  'jack-lit': svg(paint(BODY, withHot(FACES.jack, 'jack')), LIT),
  'grin': svg(paint(BODY, FACES.grin), IDLE),
  'grin-lit': svg(paint(BODY, withHot(FACES.grin, 'grin')), LIT),
  'no': svg(paint(BODY, FACES.no), ROT),
  'wait': svg(paint(BODY, FACES.wait), IDLE),
  'text': svg(TEXT, { ...IDLE, f: COLORS.ink, w: COLORS.bone }),
};

mkdirSync(OUT, { recursive: true });
for (const [name, content] of Object.entries(cursors)) writeFileSync(new URL(`${name}.svg`, OUT), content);
console.log(`wrote ${Object.keys(cursors).length} cursors to public/assets/cursors/`);
