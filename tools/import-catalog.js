#!/usr/bin/env node
'use strict';

// tools/import-catalog.js
// Usage: node tools/import-catalog.js "Artist1" "Artist2" ...
//
// Writes proposals to tunings.proposed.json (schema 2 format).
// Checkpoint per artist in tools/.import-state.json — restart-safe.
// NEVER touches tunings.json directly.
//
// To plug in a new catalogue source, fill in the SOURCE object below.
// Everything else is source-independent and should not need to change.

const { readFileSync, writeFileSync, existsSync } = require('fs');
const { join } = require('path');
const zlib = require('zlib');

// Force unbuffered stdout so watchdogs see every line immediately
if (process.stdout._handle) process.stdout._handle.setBlocking(true);
function print(s) { process.stdout.write(s + '\n'); }

// ── Source configuration ───────────────────────────────────────────────────────
//
// Fill this object to connect a new catalogue. All other code is generic.
//
// Set CATALOG_BASE_URL in the environment before running:
//   CATALOG_BASE_URL=https://api.example.com node tools/import-catalog.js "Artist"
//
// searchUrl(pattern, from)
//   Returns a URL string for searching the catalogue.
//   pattern = artist name, from = pagination offset.
//
// parseSongs(json)
//   Receives the parsed JSON response from searchUrl.
//   Returns an array of normalised song objects:
//   [{ id, artist, title }]
//   id    – stable identifier used for slug-collision disambiguation
//   artist – artist name as a string
//   title  – song title as a string
//
// parseTracks(song)
//   Receives one normalised song object (as returned by parseSongs).
//   Returns an array of guitar-track objects, each with:
//   { midi: [number, ...], views: number }
//   midi   – string pitches in the order described by tuningOrder below
//   views  – a popularity proxy (can be 0 if unavailable)
//
// tuningOrder
//   "high-to-low" if midi[0] is the highest (thinnest) string.
//   "low-to-high" if midi[0] is the lowest (thickest) string.
//   The importer reverses the array when building low-to-high note names.

const BASE_URL = process.env.CATALOG_BASE_URL || '';

const SOURCE = {
  name: 'catalogue',

  searchUrl: (pattern, from) =>
    `${BASE_URL}/songs?pattern=${encodeURIComponent(pattern)}&size=${PAGE_SIZE}&from=${from}`,

  parseSongs: (json) => json.map(s => ({
    id:     s.songId,
    artist: s.artist,
    title:  s.title,
    _raw:   s,                // keep original so parseTracks can reach it
  })),

  parseTracks: (song) => (song._raw.tracks || [])
    .filter(t =>
      t.instrument && t.instrument.includes('Guitar') &&
      Array.isArray(t.tuning) && t.tuning.length >= 6 && t.tuning.length <= 8
    )
    .map(t => ({ midi: t.tuning, views: t.views || 0 })),

  tuningOrder: 'high-to-low',
};

// ── Constants ─────────────────────────────────────────────────────────────────

const NOTES      = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const NOTE_SAFE  = {'C#':'Cs','D#':'Ds','F#':'Fs','G#':'Gs','A#':'As'};
const E_STD_6    = [64, 59, 55, 50, 45, 40];  // high-to-low
const UA         = 'guitar-tuner-importer (github.com/marr59/guitar-tuner)';
const DELAY_MS   = 1100;
const PAGE_SIZE  = 100;
const MIN_VIEWS  = parseInt(process.env.MIN_VIEWS  || '300');
const PER_ARTIST = parseInt(process.env.PER_ARTIST || '150');
const TOP_MIN    = 55;
const TOP_MAX    = 68;
const BOT_MIN    = 26;
const BOT_MAX    = 48;
const KEEPALIVE_MS = 8000;

// ── Title rejection ───────────────────────────────────────────────────────────

const REJECT_WORDS = [
  'live','acoustic','cover','remix','demo','karaoke',
  'instrumental','backing','tribute','medley','session',
  'lesson','slowed','tab','octave',
];
const REJECT_SUBS  = [
  'drop ','standard','tuning','(half step','(full step','bass down','ver.',
  // Russian
  'кавер','акустик','акустика','живьём','живьем','концерт','минус',
  'версия','оригинальном строе','ремикс','инструментал',
];
const REJECT_RX    = [
  /\d+\s*%/,
  /\(\s*\d+-string/i,
  /\d+-string\s*\)/i,
  /\bspeed\b/i,
  /\bslowed\b/i,
];

function titleRejected(title) {
  const t = title.toLowerCase();
  for (const w of REJECT_WORDS) {
    if (new RegExp(`\\b${w}\\b`).test(t)) return `word:${w}`;
  }
  for (const s of REJECT_SUBS) {
    if (t.includes(s)) return `substr:${s.trim()}`;
  }
  for (const rx of REJECT_RX) {
    if (rx.test(title)) return `rx:${rx}`;
  }
  return null;
}

// ── MIDI helpers ──────────────────────────────────────────────────────────────

function midiToNote(m) {
  return NOTES[m % 12] + String(Math.floor(m / 12) - 1);
}

function midiToStrings(midiArr) {
  // Always store strings low-to-high; reverse if source is high-to-low
  const ordered = SOURCE.tuningOrder === 'high-to-low' ? [...midiArr].reverse() : [...midiArr];
  return ordered.map(midiToNote);
}

function isEStd6(midiHighToLow) {
  return midiHighToLow.length === 6 && midiHighToLow.every((v, i) => v === E_STD_6[i]);
}

// Octave normalization: anchor on UPPER string (index 0 in high-to-low).
function normalizeOctave(midiHighToLow) {
  if (!midiHighToLow || midiHighToLow.length < 6) return null;
  let m = [...midiHighToLow];
  while (m[0] >= 70) m = m.map(x => x - 12);
  while (m[0] <= 52) m = m.map(x => x + 12);
  const top = m[0], bot = m[m.length - 1];
  if (top < TOP_MIN || top > TOP_MAX) return null;
  if (bot < BOT_MIN || bot > BOT_MAX) return null;
  if (![6, 7, 8].includes(m.length)) return null;
  return m;
}

// Convert source-order midi to high-to-low for normalization
function toHighToLow(track) {
  return SOURCE.tuningOrder === 'high-to-low' ? track.midi : [...track.midi].reverse();
}

// ── Tuning name / id ──────────────────────────────────────────────────────────

const STD  = { 5:[0,5,10,15,19],       6:[0,5,10,15,19,24],
               7:[0,5,10,15,19,24,29], 8:[0,5,10,15,19,24,29,34] };
const DROP = { 5:[0,7,12,17,21],       6:[0,7,12,17,21,26],
               7:[0,7,12,17,21,26,31], 8:[0,7,12,17,21,26,31,36] };

function toMidi(n) {
  const mo = String(n).match(/^([A-G]#?)(-?\d)$/);
  if (!mo) return null;
  return NOTES.indexOf(mo[1]) + (parseInt(mo[2]) + 1) * 12;
}

function matchIntervals(midis, pattern) {
  if (!pattern || midis.length !== pattern.length) return false;
  const base = midis[0];
  return pattern.every((offset, i) => midis[i] === base + offset);
}

function autoTuningName(strings) {
  const midis = strings.map(toMidi);
  if (midis.includes(null)) return strings.join(' ');
  const n = midis.length;
  const lowNote = NOTES[midis[0] % 12];
  const suffix  = n > 6 ? ` (${n}-string)` : '';
  if (matchIntervals(midis, STD[n]))  return `${lowNote} Standard${suffix}`;
  if (matchIntervals(midis, DROP[n])) return `Drop ${lowNote}${suffix}`;
  return strings.join(' ');
}

function autoTuningId(strings) {
  return strings.map(s =>
    (NOTE_SAFE[s.slice(0,-1)] || s.slice(0,-1)).toLowerCase() + s.slice(-1)
  ).join('-');
}

// ── Tuning table management ───────────────────────────────────────────────────

let newTunings;
let tuningMap;

function getOrCreateTuning(strings) {
  const key = strings.join(',');
  if (tuningMap.has(key)) return tuningMap.get(key);
  for (const t of newTunings) {
    if (t.strings.join(',') === key) { tuningMap.set(key, t.id); return t.id; }
  }
  let id = autoTuningId(strings);
  const existingIds = new Set(newTunings.map(t => t.id));
  let suffix = 0;
  while (existingIds.has(id)) id = autoTuningId(strings) + '-' + (++suffix);
  newTunings.push({ id, name: autoTuningName(strings), instrument: `guitar${strings.length}`, strings: [...strings] });
  tuningMap.set(key, id);
  return id;
}

// ── ID / dedup helpers ────────────────────────────────────────────────────────

const CYR = {
  'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'e','ж':'zh','з':'z',
  'и':'i','й':'y','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r',
  'с':'s','т':'t','у':'u','ф':'f','х':'h','ц':'c','ч':'ch','ш':'sh','щ':'sch',
  'ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya',
};
function translit(s) { return s.replace(/[а-яё]/g, c => CYR[c] ?? c); }

function slugify(s) {
  return translit(s.toLowerCase().replace(/['']/g,''))
    .replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
}
function makeId(artist, song) {
  const base = `${slugify(artist)}-${slugify(song)}`;
  return base || `${slugify(artist)}-${song.replace(/\D+/g,'') || 'x'}`;
}

// Unicode-aware: strips parens, lowercases, collapses ё→е, keeps all Unicode letters/digits
function normTitle(t) {
  return t.replace(/\([^)]*\)/g,'').toLowerCase().replace(/ё/g,'е').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
}
function pairKey(artist, song) {
  return `${normTitle(artist)}::${normTitle(song)}`;
}

function normalizeArtist(s) { return s.toLowerCase().replace(/[^\p{L}\p{N}]/gu,''); }

// Titles that indicate "this is the standard-tuning version of a song"
const VARIANT_MARKER_SUBS = ['оригинальном строе'];
function isVariantMarker(title) {
  const t = title.toLowerCase();
  return VARIANT_MARKER_SUBS.some(s => t.includes(s));
}

// ── Net ───────────────────────────────────────────────────────────────────────

async function fetchPage(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

// Sleep with keepalive ticks so watchdog sees output every KEEPALIVE_MS
function sleep(ms) {
  return new Promise(resolve => {
    let elapsed = 0;
    const tick = Math.min(KEEPALIVE_MS, ms);
    const id = setInterval(() => {
      elapsed += tick;
      if (elapsed < ms) {
        print(`  [keepalive +${elapsed}ms]`);
      } else {
        clearInterval(id);
        resolve();
      }
    }, tick);
  });
}

// ── Guitar track extraction + octave normalization ────────────────────────────

function extractNormalized(song, st) {
  const tracks = SOURCE.parseTracks(song);
  if (!tracks.length) return null;

  const raw = new Map();
  for (const t of tracks) {
    const key = t.midi.join(',');
    if (!raw.has(key)) raw.set(key, { midi: t.midi, views: 0 });
    raw.get(key).views += t.views;
  }

  const norm = new Map();
  for (const { midi, views } of raw.values()) {
    const htl = toHighToLow({ midi });
    const n = normalizeOctave(htl);
    if (!n) { st.discardedPlausibility++; continue; }
    const key = n.join(',');
    if (!norm.has(key)) norm.set(key, { midiHtl: n, views: 0 });
    norm.get(key).views += views;
  }

  if (!norm.size) return null;
  return [...norm.values()].sort((a, b) => b.views - a.views);
}

// ── Per-artist scan ───────────────────────────────────────────────────────────

function emptyStats() {
  return {
    fetched:0, wrongArtist:0, uniqueSongs:0, rejectedTitle:0,
    noGuitarTracks:0, discardedPlausibility:0, allEStd:0,
    belowViews:0, alreadyInBase:0, artistLimitCut:0, conflicts:0, proposed:0,
  };
}

async function scanArtist(artistName, existingIds, existingPairs, st, artistIdx, totalArtists) {
  const pool              = new Map();
  const seenIds           = new Set();
  const variantMarkerKeys = new Set();
  let from = 0;
  let page_n = 0;

  while (true) {
    await sleep(DELAY_MS);
    page_n++;
    let page;
    try {
      const url = SOURCE.searchUrl(artistName, from);
      page = SOURCE.parseSongs(await fetchPage(url));
    } catch (e) {
      print(`  [${artistIdx}/${totalArtists}] "${artistName}" pg${page_n} ERROR: ${e.message}`);
      break;
    }

    for (const song of page) {
      st.fetched++;
      if (normalizeArtist(song.artist) !== normalizeArtist(artistName)) { st.wrongArtist++; continue; }
      if (seenIds.has(song.id)) continue;
      seenIds.add(song.id);
      st.uniqueSongs++;

      const pk = pairKey(song.artist, song.title);
      if (isVariantMarker(song.title)) variantMarkerKeys.add(pk);

      if (titleRejected(song.title)) { st.rejectedTitle++; continue; }

      const tunings = extractNormalized(song, st);
      if (!tunings) { st.noGuitarTracks++; continue; }

      const nonStd = tunings.filter(t => !isEStd6(t.midiHtl));
      if (!nonStd.length) { st.allEStd++; continue; }

      const cur = pool.get(pk);
      if (!cur || nonStd[0].views > cur.tunings[0].views) {
        pool.set(pk, { song, tunings: nonStd });
      }
    }

    print(`  [${artistIdx}/${totalArtists}] "${artistName}" pg${page_n} got=${page.length} kept_so_far=${pool.size}`);

    if (page.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
    if (from > 800) break;
  }

  // Filter against catalog + views threshold
  const candidates = [];
  for (const { song, tunings } of pool.values()) {
    const pk = pairKey(song.artist, song.title);
    if (existingPairs.has(pk) || existingIds.has(makeId(song.artist, song.title))) { st.alreadyInBase++; continue; }
    if (tunings[0].views < MIN_VIEWS) { st.belowViews++; continue; }
    candidates.push({ song, tunings });
  }

  candidates.sort((a, b) => b.tunings[0].views - a.tunings[0].views);
  const cut = candidates.length - PER_ARTIST;
  if (cut > 0) st.artistLimitCut += cut;
  const top = candidates.slice(0, PER_ARTIST);

  const results = [];
  const batchIds = new Set(existingIds);
  for (const { song, tunings } of top) {
    const main    = tunings[0];
    const alts    = tunings.slice(1, 3);
    const strings = midiToStrings(main.midiHtl);
    const mainT   = getOrCreateTuning(strings);
    const altTs   = alts.map(a => getOrCreateTuning(midiToStrings(a.midiHtl)));

    let baseId = makeId(artistName, song.title);
    const entryId = batchIds.has(baseId) ? `${baseId}-${song.id}` : baseId;
    batchIds.add(entryId);

    const entry = {
      id:     entryId,
      song:   song.title,
      artist: artistName,
      t:      mainT,
    };
    const hasConflict = altTs.length > 0 || variantMarkerKeys.has(pairKey(artistName, song.title));
    if (hasConflict) { entry.c = 1; if (altTs.length) entry.alts = altTs; st.conflicts++; }
    results.push(entry);
  }
  st.proposed += results.length;
  return results;
}

// ── Checkpoint helpers ────────────────────────────────────────────────────────

function loadState(statePath) {
  if (!existsSync(statePath)) return { done: {}, proposed: [], tunings: null };
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch { return { done: {}, proposed: [], tunings: null }; }
}

function saveState(statePath, state) {
  writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
}

// ── Main ──────────────────────────────────────────────────────────────────────

function addStats(dst, src) { for (const k of Object.keys(dst)) dst[k] += (src[k]||0); }

async function main() {
  const artists = process.argv.slice(2);
  if (!artists.length) {
    print('Usage: node tools/import-catalog.js "Artist1" ...');
    process.exit(1);
  }

  const root      = join(__dirname, '..');
  const catalog   = JSON.parse(readFileSync(join(root, 'tunings.json'), 'utf8'));
  const statePath = join(__dirname, '.import-state.json');
  const outPath   = join(root, 'tunings.proposed.json');

  // Load checkpoint state
  const state = loadState(statePath);

  // Init tuning table from checkpoint (if resuming) or from catalog
  if (state.tunings && state.tunings.length) {
    newTunings = state.tunings.map(t => ({ ...t }));
  } else {
    newTunings = [...(catalog.tunings || []).map(t => ({ ...t }))];
  }
  tuningMap = new Map();
  for (const t of newTunings) tuningMap.set(t.strings.join(','), t.id);

  const existingIds   = new Set([
    ...(catalog.tunings||[]).map(t=>t.id),
    ...(catalog.songs||[]).map(s=>s.id),
  ]);
  const existingPairs = new Set((catalog.songs||[]).map(s => pairKey(s.artist, s.song)));

  // ── Control checks ──────────────────────────────────────────────────────────
  print('=== Control checks (octave normalization) ===');
  const showNorm = (midiHtl, label) => {
    const n   = normalizeOctave(midiHtl);
    const str = n ? midiToStrings(n).join(' ') : 'DISCARDED';
    const tag = n && isEStd6(n) ? '  ← E-std SKIP' : '';
    print(`  [${midiHtl}] → ${str}${tag}  (${label})`);
  };
  showNorm([64,59,55,50,45,40],       'E standard → must skip');
  showNorm([61,56,52,47,42,35],       'Drop B');
  showNorm([59,54,50,45,40,33],       'Drop A');
  showNorm([75,70,66,61,56,51,46,41], '8-str → must lower 1 oct');
  showNorm([40,35,31,26,21,14],       'Too-low bass → must discard');
  print('');

  // ── Scan ────────────────────────────────────────────────────────────────────
  const global      = emptyStats();
  const byArtist    = {};
  const allProposed = [...(state.proposed || [])];
  const failed      = [];

  // Re-accumulate global stats from already-done artists
  for (const [artist, st] of Object.entries(state.done || {})) {
    addStats(global, st);
    byArtist[artist] = st;
  }

  for (let i = 0; i < artists.length; i++) {
    const artist = artists[i];

    if (state.done && state.done[artist]) {
      print(`[${i+1}/${artists.length}] "${artist}" — SKIP (checkpoint)`);
      continue;
    }

    print(`[${i+1}/${artists.length}] Scanning "${artist}"...`);

    let proposed;
    const st = emptyStats();
    try {
      proposed = await scanArtist(artist, existingIds, existingPairs, st, i+1, artists.length);
    } catch (e) {
      print(`  ERROR scanning "${artist}": ${e.message}`);
      failed.push(artist);
      continue;
    }

    allProposed.push(...proposed);
    addStats(global, st);
    byArtist[artist] = st;

    // Save checkpoint
    state.done    = state.done || {};
    state.done[artist] = st;
    state.proposed = allProposed;
    state.tunings  = newTunings;
    saveState(statePath, state);

    print(`  ✓ "${artist}": unique=${st.uniqueSongs} proposed=${st.proposed}`);
  }

  // ── Plausibility check ───────────────────────────────────────────────────────
  print('\n=== Plausibility check: верхняя струна 55–68 ===');
  let checkPassed = 0, checkFailed = 0;
  for (const entry of allProposed) {
    const t = newTunings.find(x => x.id === entry.t);
    if (!t) { print(`  FAIL: tuning "${entry.t}" not found — ${entry.id}`); checkFailed++; continue; }
    const topMidi = toMidi(t.strings[t.strings.length - 1]);
    if (topMidi === null || topMidi < TOP_MIN || topMidi > TOP_MAX) {
      print(`  FAIL: top=${topMidi} — ${entry.artist} / ${entry.song}`);
      checkFailed++;
    } else {
      checkPassed++;
    }
  }
  print(`  проверка верхней струны: ${checkPassed} из ${checkPassed + checkFailed}`);
  if (checkFailed > 0) {
    print(`\n❌ СТОП: ${checkFailed} записей не прошли проверку. Коммит запрещён.`);
    process.exit(1);
  }
  print('  ✅ все прошли\n');

  // ── Write output ─────────────────────────────────────────────────────────────
  const outObj = {
    generated: new Date().toISOString(),
    artists,
    stats:    global,
    byArtist,
    proposed: allProposed,
    tunings:  newTunings,
  };
  const outRaw = JSON.stringify(outObj, null, 2);
  writeFileSync(outPath, outRaw, 'utf8');

  const rawKB  = Math.round(Buffer.byteLength(outRaw) / 1024);
  const gzipKB = Math.round(zlib.gzipSync(outRaw).length / 1024);

  // ── Index.html guards ────────────────────────────────────────────────────────
  const { execSync } = require('child_process');
  print('=== grep защитных ===');
  ['analyser.connect(mute)', 'detectAgainst', 'ksBuffer'].forEach(sig => {
    try {
      const n = execSync(`grep -c "${sig}" "${join(root,'index.html')}"`, {encoding:'utf8'}).trim();
      print(`  ${sig} = ${n}`);
    } catch { print(`  ${sig} = 0  ← ВНИМАНИЕ`); }
  });

  // ── Report ───────────────────────────────────────────────────────────────────
  const pad = (s, n) => String(s).padStart(n);

  print('\n=== FILTER FUNNEL ===');
  print(`Fetched from API:              ${global.fetched}`);
  print(`  - wrong artist:              ${global.wrongArtist}`);
  print(`= Unique songs:                ${global.uniqueSongs}`);
  print(`  - title keyword:             ${global.rejectedTitle}`);
  print(`  - no guitar tracks:          ${global.noGuitarTracks}`);
  print(`  - discarded plausibility:    ${global.discardedPlausibility}  (track-level)`);
  print(`  - all E standard:            ${global.allEStd}`);
  print(`  - already in base:           ${global.alreadyInBase}`);
  print(`  - below ${MIN_VIEWS} views:            ${global.belowViews}`);
  print(`  - artist cap cut:            ${global.artistLimitCut}`);
  print(`= Proposed:                    ${global.proposed}  (conflicts: ${global.conflicts})`);
  print(`\nTunings: ${catalog.tunings.length} existing + ${newTunings.length - catalog.tunings.length} new = ${newTunings.length}`);
  print(`Output: ${rawKB} KB raw / ${gzipKB} KB gzip → ${outPath}`);

  print('\n=== BY ARTIST ===');
  for (const [artist, s] of Object.entries(byArtist)) {
    print(
      `  ${artist.padEnd(24)}` +
      `  uniq:${pad(s.uniqueSongs,4)}` +
      `  titleKW:${pad(s.rejectedTitle,3)}` +
      `  noGuitar:${pad(s.noGuitarTracks,3)}` +
      `  eStd:${pad(s.allEStd,3)}` +
      `  views<${MIN_VIEWS}:${pad(s.belowViews,3)}` +
      `  ➜${pad(s.proposed,3)}` +
      (s.conflicts ? `  ⚠${s.conflicts}` : '')
    );
  }

  if (failed.length) {
    print(`\n⚠ Сбойные исполнители (${failed.length}): ${failed.join(', ')}`);
  }

  print(`\nDONE artists=${artists.length - failed.length} songs=${global.uniqueSongs} proposed=${global.proposed}`);
  print('⚠  НЕ коммить tunings.proposed.json без ревью Ильмара!');
}

main().catch(e => { print(e.stack || String(e)); process.exit(1); });
