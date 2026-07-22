#!/usr/bin/env node
'use strict';

// tools/import-songsterr.js
// Usage: node tools/import-songsterr.js "Artist1" "Artist2" ...
//
// Writes proposals to tunings.proposed.json. Never touches tunings.json directly.

const { readFileSync, writeFileSync } = require('fs');
const { join } = require('path');

// ── Constants ─────────────────────────────────────────────────────────────────

const NOTES       = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const E_STD_6     = [64, 59, 55, 50, 45, 40];   // 6-string E standard, hi→lo
const UA          = 'guitar-tuner-importer (tuner.artofrental.com)';
const DELAY_MS    = 1100;
const PAGE_SIZE   = 100;
const MIN_VIEWS   = 500;                          // filter 4
const PER_ARTIST  = 40;                           // filter 6
const MIDI_LOW_A1 = 33;                           // A1 — lowest sane fret
const MIDI_LOW_A2 = 45;                           // A2 — if above this, discard

// ── Title rejection (filter 2) ────────────────────────────────────────────────

const REJECT_WORDS = [
  'live','acoustic','cover','remix','demo','karaoke',
  'instrumental','backing','tribute','medley','session',
];
// substrings that flag transpositions / non-originals
const REJECT_SUBS  = ['drop ','standard','tuning','(half step','(full step'];

function titleRejected(title) {
  const t = title.toLowerCase();
  for (const w of REJECT_WORDS) {
    if (new RegExp(`\\b${w}\\b`).test(t)) return `word:${w}`;
  }
  for (const s of REJECT_SUBS) {
    if (t.includes(s)) return `substr:"${s.trim()}"`;
  }
  return null;
}

// ── MIDI helpers ──────────────────────────────────────────────────────────────

function midiToNote(m) {
  return NOTES[m % 12] + String(Math.floor(m / 12) - 1);
}

// Songsterr: hi→lo. Our format: lo→hi.
function tuningToStrings(midiHiLo) {
  return [...midiHiLo].reverse().map(midiToNote);
}

function isEStd6(midiHiLo) {
  return midiHiLo.length === 6 && midiHiLo.every((v, i) => v === E_STD_6[i]);
}

// Octave normalization (filter 3):
// Shift up by octaves until lowest >= A1(33). Discard if lowest > A2(45).
// Returns normalised hi→lo array, or null to discard.
function normalizeOctave(midiHiLo) {
  let m = [...midiHiLo];
  const low = () => Math.min(...m);
  while (low() < MIDI_LOW_A1) m = m.map(x => x + 12);
  if   (low() > MIDI_LOW_A2) return null;        // suspiciously high lowest string
  return m;
}

function arrEq(a, b) { return a.length === b.length && a.every((v,i) => v === b[i]); }

// ── ID / dedup helpers ────────────────────────────────────────────────────────

function slugify(s) {
  return s.toLowerCase().replace(/['']/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
}
function makeId(artist, song)    { return `${slugify(artist)}-${slugify(song)}`; }
function pairKey(artist, song)   {
  const n = s => s.toLowerCase().replace(/[^a-z0-9]/g,'');
  return `${n(artist)}::${n(song)}`;
}
function normalizeArtist(s)      { return s.toLowerCase().replace(/[^a-z0-9]/g,''); }

// ── Net ───────────────────────────────────────────────────────────────────────

async function fetchPage(pattern, from) {
  const url = `https://www.songsterr.com/api/songs?pattern=${encodeURIComponent(pattern)}&size=${PAGE_SIZE}&from=${from}`;
  const res  = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function songUrl(artist, title, id) {
  const s = str => str.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
  return `https://www.songsterr.com/a/wsa/${s(artist)}-${s(title)}-tab-s${id}`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Guitar track extraction + octave normalisation ────────────────────────────

// Returns [{midi (hi→lo, normalised), views}] sorted by views desc, or null.
function extractNormalized(tracks, st) {
  const guitar = (tracks || []).filter(t =>
    t.instrument && t.instrument.includes('Guitar') &&
    Array.isArray(t.tuning) && t.tuning.length >= 6 && t.tuning.length <= 8
  );
  if (!guitar.length) return null;

  // Accumulate views per raw tuning
  const raw = new Map();
  for (const t of guitar) {
    const key = t.tuning.join(',');
    if (!raw.has(key)) raw.set(key, { midi: t.tuning, views: 0 });
    raw.get(key).views += (t.views || 0);
  }

  // Normalize octave, collapse octave duplicates
  const norm = new Map();
  for (const { midi, views } of raw.values()) {
    const n = normalizeOctave(midi);
    if (!n) { st.suspiciousLow++; continue; }
    const key = n.join(',');
    if (!norm.has(key)) norm.set(key, { midi: n, views: 0 });
    norm.get(key).views += views;          // merge octave copies into one
  }

  if (!norm.size) return null;
  return [...norm.values()].sort((a, b) => b.views - a.views);
}

// ── Per-artist scan ───────────────────────────────────────────────────────────

async function scanArtist(artistName, existingIds, existingPairs, st) {
  const candidates = [];
  const seenIds    = new Set();
  let from = 0;

  while (true) {
    await sleep(DELAY_MS);
    let page;
    try   { page = await fetchPage(artistName, from); }
    catch (e) { console.error(`  Fetch error from=${from}: ${e.message}`); break; }

    for (const song of page) {
      st.fetched++;

      // Filter 1: exact artist match (punctuation-stripped)
      if (normalizeArtist(song.artist) !== normalizeArtist(artistName)) {
        st.wrongArtist++; continue;
      }
      if (seenIds.has(song.songId)) continue;
      seenIds.add(song.songId);
      st.uniqueSongs++;

      // Filter 2: title keywords
      if (titleRejected(song.title)) { st.rejectedTitle++; continue; }

      // Filter 7: dedup against existing catalog
      if (existingPairs.has(pairKey(song.artist, song.title)) ||
          existingIds.has(makeId(song.artist, song.title))) {
        st.alreadyInBase++; continue;
      }

      // Filters 3+5: extract, normalise, skip tracks with no guitar
      const tunings = extractNormalized(song.tracks, st);
      if (!tunings) { st.noGuitarTracks++; continue; }

      // Filter: all tunings are E standard after normalization
      const nonStd = tunings.filter(t => !isEStd6(t.midi));
      if (!nonStd.length) { st.allEStd++; continue; }

      // Filter 4: view threshold on main (highest-views) tuning
      if (nonStd[0].views < MIN_VIEWS) { st.belowViews++; continue; }

      candidates.push({ song, tunings: nonStd });
    }

    if (page.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
    if (from > 500) break;                // safety cap
  }

  // Filter 6: per-artist limit — top 40 by main views
  candidates.sort((a, b) => b.tunings[0].views - a.tunings[0].views);
  const cut = candidates.length - PER_ARTIST;
  if (cut > 0) st.artistLimitCut += cut;
  const top = candidates.slice(0, PER_ARTIST);

  // Build proposed entries
  const results = [];
  for (const { song, tunings } of top) {
    const main   = tunings[0];
    const others = tunings.slice(1, 3);  // keep at most 2 alternates (filter 8)
    if (others.length) st.conflicts++;

    const entry = {
      id:         makeId(song.artist, song.title),
      song:       song.title,
      artist:     song.artist,
      songId:     song.songId,
      confidence: 'medium',
      verified:   false,
      sources:    ['Songsterr catalog API'],
      url:        songUrl(song.artist, song.title, song.songId),
      strings:    tuningToStrings(main.midi),
      mainViews:  main.views,
    };
    if (others.length) {
      entry.candidates = others.map(o => ({ strings: tuningToStrings(o.midi), views: o.views }));
      entry.conflict = true;
    }
    results.push(entry);
  }
  st.proposed += results.length;
  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────────

function emptyStats() {
  return {
    fetched:0, wrongArtist:0, uniqueSongs:0, rejectedTitle:0, noGuitarTracks:0,
    suspiciousLow:0, allEStd:0, belowViews:0, alreadyInBase:0,
    artistLimitCut:0, conflicts:0, proposed:0,
  };
}
function addStats(dst, src) { for (const k of Object.keys(dst)) dst[k] += (src[k]||0); }

async function main() {
  const artists = process.argv.slice(2);
  if (!artists.length) {
    console.error('Usage: node tools/import-songsterr.js "Artist1" "Artist2" ...');
    process.exit(1);
  }

  const root    = join(__dirname, '..');
  const catalog = JSON.parse(readFileSync(join(root, 'tunings.json'), 'utf8'));
  const existingIds   = new Set([...(catalog.tunings||[]).map(t=>t.id), ...(catalog.songs||[]).map(s=>s.id)]);
  const existingPairs = new Set((catalog.songs||[]).map(s => pairKey(s.artist, s.song)));

  // ── Control checks ──────────────────────────────────────────────────────────
  console.log('=== Control checks ===');
  const showNorm = (midi, label) => {
    const n = normalizeOctave(midi);
    const str = n ? tuningToStrings(n).join(' ') : 'DISCARDED';
    const std = n && isEStd6(n) ? ' ← E-std SKIP' : '';
    console.log(`  [${midi}] → ${str}${std}  (${label})`);
  };
  showNorm([64,59,55,50,45,40], 'E standard — must skip');
  showNorm([61,56,52,47,42,35], 'Drop B');
  showNorm([59,54,50,45,40,33], 'Drop A');
  showNorm([49,44,40,35,30,23], 'Drop B octave-down — must collapse to same Drop B');
  console.log('');

  // ── Scan ────────────────────────────────────────────────────────────────────
  const global   = emptyStats();
  const byArtist = {};
  const allProposed = [];

  for (const artist of artists) {
    process.stdout.write(`→ "${artist}"... `);
    const st       = emptyStats();
    const proposed = await scanArtist(artist, existingIds, existingPairs, st);
    allProposed.push(...proposed);
    addStats(global, st);
    byArtist[artist] = st;
    console.log(`${st.uniqueSongs} unique → ${st.proposed} proposed`);
  }

  // ── Write ────────────────────────────────────────────────────────────────────
  const outPath = join(root, 'tunings.proposed.json');
  writeFileSync(outPath, JSON.stringify({
    generated: new Date().toISOString(),
    artists,
    globalStats: global,
    byArtist,
    proposed: allProposed,
  }, null, 2), 'utf8');

  // ── Report ───────────────────────────────────────────────────────────────────
  console.log('\n=== FILTER FUNNEL (global) ===');
  console.log(`Fetched from API:          ${global.fetched}`);
  console.log(`  - wrong artist:          ${global.wrongArtist}`);
  console.log(`= Unique songs:            ${global.uniqueSongs}`);
  console.log(`  - title keyword:         ${global.rejectedTitle}`);
  console.log(`  - already in base:       ${global.alreadyInBase}`);
  console.log(`  - no guitar tracks:      ${global.noGuitarTracks}`);
  console.log(`  - (suspicious tunings):  ${global.suspiciousLow}  (track-level, not song)`);
  console.log(`  - all E standard:        ${global.allEStd}`);
  console.log(`  - below ${MIN_VIEWS} views:        ${global.belowViews}`);
  console.log(`  - artist cap cut:        ${global.artistLimitCut}`);
  console.log(`= Proposed:                ${global.proposed}  (of which ⚠ conflict: ${global.conflicts})`);

  console.log('\n=== BY ARTIST ===');
  const pad = (s, n) => String(s).padStart(n);
  for (const [artist, s] of Object.entries(byArtist)) {
    console.log(
      `  ${artist.padEnd(22)}` +
      `  unique:${pad(s.uniqueSongs,4)}` +
      `  titleKW:${pad(s.rejectedTitle,3)}` +
      `  noGuitar:${pad(s.noGuitarTracks,3)}` +
      `  eStd:${pad(s.allEStd,3)}` +
      `  views<${MIN_VIEWS}:${pad(s.belowViews,3)}` +
      `  proposed:${pad(s.proposed,3)}` +
      (s.conflicts ? `  ⚠${s.conflicts}` : '')
    );
  }

  console.log('\n=== FIRST 10 PROPOSED ===');
  allProposed.slice(0,10).forEach((e,i) => {
    console.log(`${pad(i+1,2)}. [${e.strings.join(' ')}]  ${e.artist} — ${e.song}${e.conflict ? '  ⚠' : ''}`);
    (e.candidates||[]).forEach(c => console.log(`      alt: [${c.strings.join(' ')}] (${c.views}v)`));
  });

  console.log(`\nOutput → ${outPath}  (${allProposed.length} entries)`);
}

main().catch(e => { console.error(e.stack || e); process.exit(1); });
