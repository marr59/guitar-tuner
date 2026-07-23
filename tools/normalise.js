#!/usr/bin/env node
'use strict';

// tools/normalise.js
// Converts tunings.json from schema 1 (variants[]) to schema 2 (compact).
// Verifies roundtrip for all songs before writing.
// Usage: node tools/normalise.js

const { readFileSync, writeFileSync } = require('fs');
const { join } = require('path');

// ── MIDI helpers ──────────────────────────────────────────────────────────────

const NOTES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const NOTE_SAFE = {'C#':'Cs','D#':'Ds','F#':'Fs','G#':'Gs','A#':'As'};

function toMidi(n) {
  const m = String(n).match(/^([A-G]#?)(-?\d)$/);
  if (!m) return null;
  return NOTES.indexOf(m[1]) + (parseInt(m[2]) + 1) * 12;
}

// ── Auto tuning name / id ─────────────────────────────────────────────────────

// Interval patterns from lowest string (semitones)
const STD  = { 5:[0,5,10,15,19],        6:[0,5,10,15,19,24],
               7:[0,5,10,15,19,24,29],  8:[0,5,10,15,19,24,29,34] };
const DROP = { 5:[0,7,12,17,21],        6:[0,7,12,17,21,26],
               7:[0,7,12,17,21,26,31],  8:[0,7,12,17,21,26,31,36] };

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
  return strings.map(s => (NOTE_SAFE[s.slice(0,-1)] || s.slice(0,-1)).toLowerCase() + s.slice(-1)).join('-');
}

function autoInstrument(strings) {
  const n = strings.length;
  return n >= 4 && n <= 8 ? `guitar${n}` : `guitar${n}`;
}

// ── Template notes ────────────────────────────────────────────────────────────

const TEMPLATE_NOTES = new Map([
  ['Imported from the Songsterr catalogue; reflects the transcriber\'s tuning, not verified against the record.', 'songsterr'],
  ['Imported from the Songsterr catalogue; reflects the transcriber\'s tuning, not verified against the recording.', 'songsterr'],
  ['A second transcription uses this tuning. Unresolved — check by ear.', 'conflict'],
  ['Drop D.', 'drop-d'],
]);

const NOTES_DICT = {
  songsterr: 'Imported from the Songsterr catalogue; reflects the transcriber\'s tuning, not verified against the recording.',
  conflict:  'A second transcription uses this tuning. Unresolved — check by ear.',
  'drop-d':  'Drop D.',
};

// ── URL → sid ─────────────────────────────────────────────────────────────────

function extractSid(url) {
  if (!url) return null;
  const m = url.match(/-s(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const root    = join(__dirname, '..');
const srcPath = join(root, 'tunings.json');
const src     = JSON.parse(readFileSync(srcPath, 'utf8'));

if (src.schema === 2) {
  console.log('Already schema 2 — nothing to do.');
  process.exit(0);
}

// Build tuning table (strings key → id)
const tuningMap  = new Map();   // "B1,F#2,..." → id
const newTunings = src.tunings.map(t => ({ ...t }));

function addTuning(strings) {
  const key = strings.join(',');
  if (tuningMap.has(key)) return tuningMap.get(key);
  // Check existing table
  for (const t of newTunings) {
    if (t.strings.join(',') === key) { tuningMap.set(key, t.id); return t.id; }
  }
  // Auto-generate
  let id = autoTuningId(strings);
  // Guard against collisions with existing ids
  let suffix = 0;
  const existingIds = new Set(newTunings.map(t => t.id));
  while (existingIds.has(id)) id = autoTuningId(strings) + '-' + (++suffix);

  newTunings.push({
    id,
    name:       autoTuningName(strings),
    instrument: autoInstrument(strings),
    strings:    [...strings],
  });
  tuningMap.set(key, id);
  return id;
}

// Pre-populate
for (const t of newTunings) addTuning(t.strings);

// ── Convert songs ─────────────────────────────────────────────────────────────

const newSongs = [];
const roundtripErrors = [];
let autoAdded = 0;

for (const song of src.songs) {
  if (!song.variants || !song.variants.length) {
    roundtripErrors.push(`${song.id}: no variants[]`); continue;
  }

  const before = newTunings.length;
  const mainV  = song.variants[0];
  const mainT  = addTuning(mainV.strings);
  autoAdded   += newTunings.length - before;

  const altTs  = song.variants.slice(1).map(v => {
    const b = newTunings.length;
    const id = addTuning(v.strings);
    autoAdded += newTunings.length - b;
    return id;
  });

  const entry = { id: song.id, song: song.song, artist: song.artist, t: mainT };

  const sid = extractSid(song.url);
  if (sid) entry.sid = sid;

  if (altTs.length) { entry.c = 1; entry.alts = altTs; }

  // Note: template → src, unique → note
  const note    = (mainV.note || '').trim();
  const srcCode = TEMPLATE_NOTES.get(note);
  if (srcCode)   entry.src  = srcCode;
  else if (note) entry.note = note;

  // Hand-curated metadata
  if (song.confidence === 'high') entry.confidence = 'high';
  if (song.verified   === true)   entry.verified   = true;

  newSongs.push(entry);
}

// ── Roundtrip check ───────────────────────────────────────────────────────────

const tuningById = new Map(newTunings.map(t => [t.id, t.strings]));
let ok = 0;

for (let i = 0; i < src.songs.length; i++) {
  const orig   = src.songs[i];
  const conv   = newSongs[i];
  if (!conv) continue;
  const restored = tuningById.get(conv.t);
  const original = orig.variants[0].strings;
  if (!restored) {
    roundtripErrors.push(`${orig.id}: tuning id "${conv.t}" not in table`); continue;
  }
  if (restored.join(',') !== original.join(',')) {
    roundtripErrors.push(`${orig.id}:\n  orig     [${original.join(',')}]\n  restored [${restored.join(',')}]`); continue;
  }
  ok++;
}

if (roundtripErrors.length) {
  console.error(`\n❌ Roundtrip FAILED (${roundtripErrors.length} errors):`);
  roundtripErrors.forEach(e => console.error(' ', e));
  process.exit(1);
}
console.log(`✅ Roundtrip OK: ${ok}/${src.songs.length}`);

// ── Write ─────────────────────────────────────────────────────────────────────

const out = {
  schema:  2,
  updated: src.updated || new Date().toISOString().slice(0, 10),
  note:    'strings[] is ordered low→high. Focus is ALTERNATE tunings (E standard not catalogued). songs[].t references tunings[].id; expand to strings[] on load.',
  notes:   NOTES_DICT,
  tunings: newTunings,
  songs:   newSongs,
};

const srcRaw = JSON.stringify(src, null, 2);
const outRaw = JSON.stringify(out, null, 2);
writeFileSync(srcPath, outRaw, 'utf8');

const srcKB = Math.round(Buffer.byteLength(srcRaw) / 1024);
const outKB = Math.round(Buffer.byteLength(outRaw) / 1024);
console.log(`Size: ${srcKB} KB → ${outKB} KB raw  (${Math.round((1 - outKB/srcKB)*100)}% smaller)`);
console.log(`Tunings: ${src.tunings.length} → ${newTunings.length}  (${autoAdded} auto-added)`);
console.log(`Songs: ${src.songs.length} → ${newSongs.length}`);
console.log(`\nAuto-generated tunings:`);
newTunings.slice(src.tunings.length).forEach(t =>
  console.log(`  ${t.id.padEnd(42)} "${t.name}"`)
);
