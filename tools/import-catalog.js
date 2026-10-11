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
const BOT_MIN    = 25;   // C#1 (34.6 Hz) — the low string of a standard 9-string guitar
const BOT_MAX    = 48;
const KEEPALIVE_MS = 8000;

// ── Title rejection ───────────────────────────────────────────────────────────

const REJECT_WORDS = [
  'live','acoustic','cover','remix','demo','karaoke',
  'instrumental','backing','tribute','medley','session',
  'lesson','slowed','tab','octave',
  'unplugged','dvd','tour',
];
const REJECT_SUBS  = [
  'drop ','standard','tuning','(half step','(full step','bass down','ver.',
  // Russian
  'кавер','акустик','акустика','живьём','живьем','концерт','минус',
  'версия','оригинальном строе','ремикс','инструментал',
  // Spanish / Portuguese — «Ao vivo», «EN VIVO», «Acústico MTV». Голое «vivo»
  // не берём: песни с таким названием существуют, режем только оборот.
  'ao vivo','en vivo','en directo','acustico','acústico','acustica','acústica',
  'version acustica','versión acústica',
  // Строй, вынесенный в название: «RUBÃO (Afinado em Eb)», «Sopla el Pampero (D Estándar)»
  'afinado','afinação','afinacao','afinacion','afinación','estándar','estandar',
  // Korean / Japanese / Chinese — the Latin keyword list never sees these, and
  // the Korean scene is full of them: 챠우챠우 라이브 is a live take, not a song.
  '라이브','커버','어쿠스틱','리믹스','연주','반주',
  'ライブ','カバー','アコースティック','リミックス','インスト',
  '现场','翻唱','翻弹','原声','伴奏','改编',
];
const REJECT_RX    = [
  /\d+\s*%/,
  /\(\s*\d+-string/i,
  /\d+-string\s*\)/i,
  /\bspeed\b/i,
  /\bslowed\b/i,
  /\(\s*(?:ai|ia)\s*\)/i,       // «Chaos Corporation (AI)», «Poder latino (IA)» — машинный таб
  /\(\s*drop\s*\)/i,            // «Os calo (drop)» — пометка о строе без пробела после слова
];

// A tab revision marker is either a whole trailing bracket ("(V2)") or a
// separate word carrying a number (" v2", " Ver 2", " wersja 2"). Both forms
// need the number: "(Full Version)" and "Better Version" are remarks about the
// transcription, not a revision index, and stripping a bare "ver" eats the end
// of Forever, Game Over and AOV.
// "Marigold 7string", "Dagger 6 string", "Absolomb (5 string)" are the same song
// written out for a different string count. Rejecting them threw away a playable
// alternative; stripping the marker folds them onto the base song instead, where
// a differing tuning is recorded as a second version.
const STRING_COUNT_RX = [
  /\s*[\(\[]\s*(?:for\s+)?\d+(?:\/\d+)?\s*strings?(?:\s+(?:version|edition))?\s*[\)\]]\s*$/i,
  /\s*\b(?:for\s+)?\d+(?:\/\d+)?\s*strings?(?:\s+(?:version|edition))?\s*$/i,
];

const VERSION_RX = [
  /\s*[\(\[]\s*(?:v|ver|version|wersja|versione|versi[o\u00f3]n)\s*\.?\s*\d+\s*[\)\]]\s*$/i,
  /\s+(?:v|ver|version|wersja|versione|versi[o\u00f3]n)\s*\.?\s*\d+\s*$/i,
];
// Uploaders tag a title with where it came from: "Don't care anymore
// @communeslive1126". The handle is not part of the song.
// Пробел перед @ обязателен, иначе правило съедает лит-спик внутри названия:
// «gl@tch» у Parkway Drive и «H@rd3r» у Korn превратились бы в «gl» и «H».
const HANDLE_RX = /\s+@[^\s@]+\s*$/;

function stripVersionSuffix(title) {
  let t = title.replace(HANDLE_RX, '');
  for (const rx of STRING_COUNT_RX) t = t.replace(rx, '');
  for (const rx of VERSION_RX) t = t.replace(rx, '');
  t = t.replace(/\s*[-\u2013\u2014]\s*$/, '').trim();
  return t.length >= 2 ? t : title;
}

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

// A transcription typo we have seen repeatedly: one string written an octave
// off, so the string set stops ascending (A1 D2 A2 D3 G4 B3 — G in the fourth
// octave where the third belongs). Genuine non-ascending tunings exist (Nashville
// high-strung, some open tunings), and those cannot be repaired by moving a
// single string an octave — which is exactly what separates them from the typo.
function octaveTypo(midiHighToLow) {
  const m = [...midiHighToLow].reverse();            // low-to-high
  const asc = a => a.every((v, i) => i === 0 || v >= a[i-1]);
  if (asc(m)) return false;
  for (let i = 0; i < m.length; i++) {
    for (const d of [12, -12]) {
      const t = [...m]; t[i] += d;
      if (asc(t) && t[i] >= 20 && t[i] <= 76) return true;
    }
  }
  return false;
}

// A string set where two neighbours sit more than an octave and a tone apart is
// not an instrument, it is a transcription with a string missing or misread
// (E1 A1 D3 G3 B3 E4 jumps 17 semitones from A1 to D3). The ceiling is measured,
// not guessed: across 286 tunings already in the catalogue the widest neighbour
// gap is 13, and that only in paired twelve-string courses.
function implausibleGap(midiHighToLow) {
  const m = [...midiHighToLow].reverse();
  for (let i = 1; i < m.length; i++) {
    if (Math.abs(m[i] - m[i-1]) >= 14) return true;
  }
  return false;
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
  if (octaveTypo(m)) return null;
  if (implausibleGap(m)) return null;
  return m;
}

// Convert source-order midi to high-to-low for normalization
function toHighToLow(track) {
  return SOURCE.tuningOrder === 'high-to-low' ? track.midi : [...track.midi].reverse();
}

// ── Tuning name / id ──────────────────────────────────────────────────────────

// Intervals measured off the real instruments, not extrapolated: a seven-string
// standard is B E A D G B E (0 5 10 15 20 24 29), and the major third sits
// between the second and third string whatever the string count. Extending the
// six-string row by +5 per string — which is what used to be here — puts that
// third in the wrong place and hands a "B Standard (7-string)" label to a tuning
// that is a semitone off on one string.
const STD  = { 5:[0,5,10,15,19],        6:[0,5,10,15,19,24],
               7:[0,5,10,15,20,24,29],  8:[0,5,10,15,20,25,29,34] };
const DROP = { 5:[0,7,12,17,21],        6:[0,7,12,17,21,26],
               7:[0,7,12,17,22,26,31],  8:[0,7,12,17,22,27,31,36] };

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
  // Extended-range guitars are often a familiar six-string set with one extra
  // low string bolted underneath (Dir En Grey play Drop D with a low A below it).
  // Naming that beats dumping the raw note list on the user.
  if (n > 6) {
    const rest = midis.slice(1);
    const restNote = NOTES[rest[0] % 12];
    if (matchIntervals(rest, STD[n-1]))  return `${restNote} Standard + low ${lowNote} (${n}-string)`;
    if (matchIntervals(rest, DROP[n-1])) return `Drop ${restNote} + low ${lowNote} (${n}-string)`;
  }
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
  return translit(fold(s).toLowerCase().replace(/['']/g,''))
    .replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
}
function makeId(artist, song) {
  const base = `${slugify(artist)}-${slugify(song)}`;
  return base || `${slugify(artist)}-${song.replace(/\D+/g,'') || 'x'}`;
}

// Unicode-aware: strips parens, lowercases, collapses ё→е, keeps all Unicode letters/digits
function normTitle(t) {
  return fold(t).replace(/\([^)]*\)/g,'').toLowerCase().replace(/ё/g,'е')
          .replace(/'/g,'').replace(/\u2019/g,'')
          .replace(/[^\p{L}\p{N}]+/gu,' ').trim();
}
function pairKey(artist, song) {
  return `${normTitle(artist)}::${normTitle(song)}`;
}

// Диакритику складываем, иначе латиноамериканская сцена не сходится: источник
// пишет Sarcófago, Ratos de Porão, Café Tacvba, División Minúscula, Zoé — а в
// запросе и в каталоге то же имя обычно без надстрочных знаков. \p{L} считает
// «ó» отдельной буквой, поэтому до разложения NFD имена просто не совпадают.
function fold(s) { return s.normalize('NFD').replace(/\p{M}+/gu, ''); }

function normalizeArtist(s) { return fold(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu,''); }

// ── Artist aliases ────────────────────────────────────────────────────────────
//
// Some catalogues file an artist under evasive names ("Not <Artist>", scrambled
// titles) instead of the real one. tools/artist-aliases.json maps the canonical
// name to whatever the source actually uses; entries are always stored under the
// canonical name. Optional per-artist titleFixes repairs scrambled song titles,
// titleReject drops tab variants that are not songs.

function loadAliases() {
  const p = join(__dirname, 'artist-aliases.json');
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; }
}

const ALIAS_FILE = loadAliases();

function aliasConfig(artistName) {
  const key = normalizeArtist(artistName);
  for (const [canonical, cfg] of Object.entries(ALIAS_FILE)) {
    if (canonical.startsWith('_')) continue;
    if (normalizeArtist(canonical) === key) return cfg;
  }
  return null;
}

function artistAccepted(sourceArtist, artistName, cfg) {
  const a = normalizeArtist(sourceArtist);
  if (a === normalizeArtist(artistName)) return true;
  if (!cfg) return false;
  return (cfg.aliases || []).some(x => normalizeArtist(x) === a);
}

function fixTitle(title, cfg) {
  if (!cfg || !cfg.titleFixes) return title;
  const want = normTitle(title);
  for (const [from, to] of Object.entries(cfg.titleFixes)) {
    if (normTitle(from) === want) return to;
  }
  return title;
}

function titleRejectedByArtist(title, cfg) {
  if (!cfg || !cfg.titleReject) return null;
  const t = title.toLowerCase();
  for (const s of cfg.titleReject) {
    if (t.includes(s.toLowerCase())) return `artist:${s}`;
  }
  return null;
}

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
    fetched:0, wrongArtist:0, uniqueSongs:0, rejectedTitle:0, titleFixed:0,
    noGuitarTracks:0, discardedPlausibility:0, allEStd:0,
    belowViews:0, alreadyInBase:0, artistLimitCut:0, conflicts:0, proposed:0,
  };
}

async function scanArtist(artistName, existingIds, existingPairs, st, artistIdx, totalArtists) {
  const cfg               = aliasConfig(artistName);
  if (cfg && (cfg.aliases || []).length) {
    print(`  [${artistIdx}/${totalArtists}] "${artistName}" — aliases enabled: ${(cfg.aliases||[]).join(', ')}`);
  }
  const pool              = new Map();
  const seenIds           = new Set();
  const variantMarkerKeys = new Set();
  let page_n = 0;

  // Search under every known spelling, not just the canonical one: a catalogue
  // that files a band under its Japanese name will not answer to a romanisation.
  const patterns = [artistName, ...((cfg && cfg.aliases) || [])];

  for (const pattern of patterns) {
  let from = 0;
  let exhausted = false;
  while (!exhausted) {
    await sleep(DELAY_MS);
    page_n++;
    let page;
    try {
      const url = SOURCE.searchUrl(pattern, from);
      page = SOURCE.parseSongs(await fetchPage(url));
    } catch (e) {
      print(`  [${artistIdx}/${totalArtists}] "${pattern}" pg${page_n} ERROR: ${e.message}`);
      break;
    }

    for (const song of page) {
      st.fetched++;
      if (!artistAccepted(song.artist, artistName, cfg)) { st.wrongArtist++; continue; }
      if (seenIds.has(song.id)) continue;
      seenIds.add(song.id);
      st.uniqueSongs++;

      // Reject on the UNTOUCHED title. Stripping first let "Seeing Red cover"
      // become "Seeing Red co", which no longer matches \bcover\b — the strip
      // was quietly smuggling covers and live takes past their own filter.
      if (titleRejected(song.title) || titleRejectedByArtist(song.title, cfg)) { st.rejectedTitle++; continue; }

      const stripped = stripVersionSuffix(song.title);
      if (stripped !== song.title) { st.titleFixed++; song.title = stripped; }

      const fixed = fixTitle(song.title, cfg);
      if (fixed !== song.title) { st.titleFixed++; song.title = fixed; }

      // Always key on the canonical artist: aliases must collapse onto one song
      const pk = pairKey(artistName, song.title);
      if (isVariantMarker(song.title)) variantMarkerKeys.add(pk);

      const tunings = extractNormalized(song, st);
      if (!tunings) { st.noGuitarTracks++; continue; }

      const nonStd = tunings.filter(t => !isEStd6(t.midiHtl));
      if (!nonStd.length) { st.allEStd++; continue; }

      const cur = pool.get(pk);
      if (!cur || nonStd[0].views > cur.tunings[0].views) {
        pool.set(pk, { song, tunings: nonStd });
      }
    }

    print(`  [${artistIdx}/${totalArtists}] "${pattern}" pg${page_n} got=${page.length} kept_so_far=${pool.size}`);

    if (page.length < PAGE_SIZE) exhausted = true;
    from += PAGE_SIZE;
    if (from > 800) exhausted = true;
  }
  }

  // Filter against catalog + views threshold
  const candidates = [];
  for (const { song, tunings } of pool.values()) {
    const pk = pairKey(artistName, song.title);
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
  if (global.titleFixed) print(`  ~ titles repaired (alias):   ${global.titleFixed}`);
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
