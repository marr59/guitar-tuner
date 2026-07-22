#!/usr/bin/env node
'use strict';

// tools/import-songsterr.js
// Usage: node tools/import-songsterr.js "Artist1" "Artist2" ...
//
// Fetches guitar tunings from the Songsterr catalog API and proposes new
// entries for tunings.json. Results go to tunings.proposed.json — never
// directly to tunings.json. Review before merging.

const { readFileSync, writeFileSync, mkdirSync } = require('fs');
const { join } = require('path');

const NOTES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const E_STANDARD_HI_LO = [64, 59, 55, 50, 45, 40];
const UA  = 'guitar-tuner-importer (tuner.artofrental.com)';
const DELAY_MS  = 1100;
const PAGE_SIZE = 100;
// Keywords that suggest a song entry is a transposition, not the original
const TRANSPOSED_KW = [
  'drop a','drop b','drop c','drop d','drop e',
  'd standard','c standard','b standard','a standard',
  'e♭ standard','e-flat','e flat','half step','whole step',
];

// ── Conversion helpers ────────────────────────────────────────────────────────

function midiToNote(midi) {
  return NOTES[midi % 12] + String(Math.floor(midi / 12) - 1);
}

// Songsterr gives high→low; our catalog is low→high.
function tuningToStrings(midiHiLo) {
  return [...midiHiLo].reverse().map(midiToNote);
}

function isEStandard(midiHiLo) {
  return midiHiLo.length === 6 &&
    midiHiLo.every((v, i) => v === E_STANDARD_HI_LO[i]);
}

function isTransposedTitle(title) {
  const t = title.toLowerCase();
  return TRANSPOSED_KW.some(k => t.includes(k));
}

function slugify(s) {
  return s.toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function makeId(artist, song) {
  return `${slugify(artist)}-${slugify(song)}`;
}

// Normalised key for artist+song dedup (handles "Chop Suey!" ≡ "chop suey", etc.)
function pairKey(artist, song) {
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return `${norm(artist)}::${norm(song)}`;
}

function arrEq(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── API ───────────────────────────────────────────────────────────────────────

async function fetchPage(pattern, from) {
  const url =
    `https://www.songsterr.com/api/songs` +
    `?pattern=${encodeURIComponent(pattern)}&size=${PAGE_SIZE}&from=${from}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function songUrl(artist, title, songId) {
  const s = str => str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `https://www.songsterr.com/a/wsa/${s(artist)}-${s(title)}-tab-s${songId}`;
}

// Returns array of { midi, views } sorted by views desc (unique tunings only).
function extractGuitarTunings(tracks) {
  const guitar = (tracks || []).filter(t =>
    t.instrument && t.instrument.includes('Guitar') &&
    Array.isArray(t.tuning) && t.tuning.length === 6
  );
  if (!guitar.length) return [];

  const map = new Map();
  for (const t of guitar) {
    const key = t.tuning.join(',');
    if (!map.has(key)) map.set(key, { midi: t.tuning, views: 0 });
    map.get(key).views += (t.views || 0);
  }
  return [...map.values()].sort((a, b) => b.views - a.views);
}

// ── Per-artist processing ─────────────────────────────────────────────────────

async function processArtist(artistName, existingIds, existingPairs, stats) {
  const results = [];
  const seenSongIds = new Set();
  let from = 0;

  while (true) {
    await sleep(DELAY_MS);
    let page;
    try {
      page = await fetchPage(artistName, from);
    } catch (e) {
      console.error(`  Fetch error at from=${from}: ${e.message}`);
      break;
    }

    const mine = page.filter(s => s.artist.toLowerCase() === artistName.toLowerCase());

    for (const song of mine) {
      if (seenSongIds.has(song.songId)) continue;
      seenSongIds.add(song.songId);
      stats.scanned++;

      // Skip if already in catalog (by generated id OR by artist+song pair)
      const id = makeId(song.artist, song.title);
      const pair = pairKey(song.artist, song.title);
      if (existingIds.has(id) || existingPairs.has(pair)) {
        stats.alreadyInBase++;
        continue;
      }

      const allTunings = extractGuitarTunings(song.tracks);
      if (!allTunings.length) continue;

      // All tunings are E standard → skip (we only catalogue alternates)
      const nonStd = allTunings.filter(t => !isEStandard(t.midi));
      if (!nonStd.length) {
        stats.skippedEStd++;
        continue;
      }

      const main = nonStd[0]; // highest views
      const others = nonStd.slice(1);
      const conflict = others.length > 0;
      if (conflict) stats.conflicts++;

      const entry = {
        id,
        song:     song.title,
        artist:   song.artist,
        songId:   song.songId,
        confidence: 'medium',
        verified: false,
        sources:  ['Songsterr catalog API'],
        url:      songUrl(song.artist, song.title, song.songId),
        strings:  tuningToStrings(main.midi),
        mainViews: main.views,
      };

      if (others.length) {
        entry.candidates = others.map(o => ({
          strings: tuningToStrings(o.midi),
          views: o.views,
        }));
      }
      if (conflict)                       entry.conflict    = true;
      if (isTransposedTitle(song.title))  entry.transposed  = true;

      results.push(entry);
      stats.proposed++;
    }

    // Stop when last page or no more of this artist
    if (page.length < PAGE_SIZE || mine.length === 0) break;
    from += PAGE_SIZE;
    if (from > 500) break; // safety cap — 500 songs per artist is more than enough
  }

  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const artists = process.argv.slice(2);
  if (!artists.length) {
    console.error('Usage: node tools/import-songsterr.js "Artist1" "Artist2" ...');
    process.exit(1);
  }

  const root    = join(__dirname, '..');
  const catalog = JSON.parse(readFileSync(join(root, 'tunings.json'), 'utf8'));

  const existingIds   = new Set([
    ...(catalog.tunings || []).map(t => t.id),
    ...(catalog.songs   || []).map(s => s.id),
  ]);
  const existingPairs = new Set(
    (catalog.songs || []).map(s => pairKey(s.artist, s.song))
  );

  // ── Control checks ──────────────────────────────────────────────────────────
  console.log('=== Control checks ===');
  const chk = (midi, label) => {
    const strings = tuningToStrings(midi);
    const std     = isEStandard(midi);
    console.log(`${JSON.stringify(midi)} → ${strings.join(' ')}  ${std ? '← E standard, SKIP' : ''}  (${label})`);
  };
  chk([64,59,55,50,45,40], 'E standard — must be skipped');
  chk([61,56,52,47,42,35], 'Drop B');
  chk([59,54,50,45,40,33], 'Drop A');
  console.log('');

  // ── Scan ────────────────────────────────────────────────────────────────────
  const stats = {
    scanned: 0, proposed: 0, skippedEStd: 0, alreadyInBase: 0, conflicts: 0
  };
  const allProposed = [];

  for (const artist of artists) {
    console.log(`→ "${artist}"...`);
    const proposed = await processArtist(artist, existingIds, existingPairs, stats);
    allProposed.push(...proposed);
    console.log(`  ${proposed.length} proposed`);
  }

  // ── Write output ─────────────────────────────────────────────────────────────
  const outPath = join(root, 'tunings.proposed.json');
  writeFileSync(outPath, JSON.stringify({
    generated: new Date().toISOString(),
    artists,
    stats,
    proposed: allProposed,
  }, null, 2), 'utf8');

  // ── Report ──────────────────────────────────────────────────────────────────
  console.log('\n=== REPORT ===');
  console.log(`Scanned:          ${stats.scanned}`);
  console.log(`Proposed:         ${stats.proposed}`);
  console.log(`Skipped E std:    ${stats.skippedEStd}`);
  console.log(`Already in base:  ${stats.alreadyInBase}`);
  console.log(`Conflicts:        ${stats.conflicts}`);
  console.log(`\nOutput → ${outPath}`);
  console.log('\nFirst 10 proposed:');
  allProposed.slice(0, 10).forEach((e, i) => {
    const flags = [
      e.conflict   && '⚠ conflict',
      e.transposed && 'ℹ transposed',
    ].filter(Boolean).join(' ');
    console.log(`${String(i + 1).padStart(2)}. [${e.strings.join(' ')}]  ${e.artist} — ${e.song}  ${flags}`);
    if (e.candidates) {
      e.candidates.forEach(c => {
        console.log(`      alt: [${c.strings.join(' ')}] (${c.views} views)`);
      });
    }
  });
}

main().catch(e => { console.error(e.stack || e); process.exit(1); });
