# Guitar Tuner

A fast, free guitar tuner with a curated library of **3,500 alternate tunings** for specific
songs, across 72 artists — including a corner of the Russian alternative scene that no other
tuning database covers.

**Live → [marr59.github.io/guitar-tuner](https://marr59.github.io/guitar-tuner/)**

Pick a song, see the tuning it was recorded in, retune, play. No account, no signup, no
paywall, no ads. Installs to your home screen and works with no signal.

---

## What it does

- **Accurate pitch detection** down to low B and F#, reading out in cents
- **Tuning library** — 3,500 songs across 72 artists, searchable offline
- **Alternate tunings only** — songs in plain E standard are deliberately not catalogued
- **Multiple versions per song** where studio and live tunings genuinely differ
- **Experimental tunings preserved** — Soundgarden's six-strings-of-E "Mind Riot", Sonic
  Youth's unison and out-of-order sets, Joni Mitchell's open tunings
- **Russian alt scene** — Психея, [AMATORY], Stigmata, Lumen, Jane Air and others, largely
  undocumented in English-language sources
- **Plucked-string reference tones** — tap a string to hear its target pitch
- **Auto-advance** — tune a string and it moves to the next, in whichever direction you're working
- **Any string count** — 4 to 8 strings, so seven-strings, bass and ukulele all work
- **Custom tunings** you can build, name, rename and delete
- **A4 calibration** from 432 to 444 Hz for old recordings and ensemble playing
- **Three themes**, including a warm dark one for stage and dim rooms
- **Offline** via service worker, with JSON export/import of your library

---

## Why it exists

Most tuners handle E standard and a handful of drop tunings. The annoying part of playing
metal isn't the tuning itself, it's *finding out* which tuning a song uses, which usually
means digging through tab sites and forum threads that contradict each other.

Slipknot's "Vermilion Pt. 2" is the example that started this project. Most published tabs
are written in E standard because it reads more easily that way. The record is in Drop B.
Trust the tabs and you learn the song in the wrong key.

So the app pairs an accurate tuner with a curated database of *alternate* tunings, tied to
specific songs and albums. Songs that are just plain E standard are left out on purpose:
their absence is itself useful information.

---

## Engineering notes

No frameworks, no build step, no backend. One HTML file, one JSON catalogue, a service
worker. That constraint was worth keeping: deploying is a `git push` and it runs on a
phone in a rehearsal room with no signal.

### Pitch detection is target-constrained

The obvious design — detect whatever note is playing, then work out which string it is —
turns out to be the wrong one. In low tunings like Drop B the strings sit close together and
are rich in harmonics, so the detector regularly locks onto a neighbouring string or an
octave partial.

Instead the player picks the string first. Because the target frequency is then known, the
detector only has to answer "how far is this from *that* note", and it can restrict its
period search to ±700 cents around the expected one. Octave errors and neighbour-string
confusion stop being possible, rather than being fought with heuristics.

The detector is a YIN-style cumulative difference function with a coarse pass, a fine pass,
and parabolic interpolation of the minimum. Measured against synthetic plucked-string
signals: **better than 0.15 cents** across F#1 to E4, including strings detuned by up to 180
cents.

### The needle holds instead of guessing

The difference function also yields an aperiodicity figure, which becomes a confidence
score. On a cleanly plucked string it sits around 0.98; on a noisy but valid signal 0.82; on
room noise 0.10; on silence 0.00.

Below a threshold of 0.55 the reading is discarded and the needle **holds its last position**
rather than darting around. Combined with a median filter over recent readings and an
exponential glide rendered at 60fps independently of the analysis rate, that is what makes
the display feel calm instead of nervous.

### Reference tones are physically modelled

Tapping a string plays its target pitch. The first version stacked five sine partials under
one shared envelope and sounded like a whistle, because real strings don't decay uniformly:
high harmonics die far faster than low ones.

The current version is a Karplus-Strong plucked string — a filtered noise burst circulating
through a delay line, comb-filtered at the pick position, voiced through a light body EQ. It
sounds like a string because it is simulating one, and it costs zero bytes of audio assets.

One catch worth recording: the delay line length has to be **fractional**. Rounding it to
whole samples put the pitch up to 15.7 cents off, which is worse than useless in a tuner
since you would tune your guitar to a lie. A first-order allpass section supplies the
fractional part and brings the error under 0.1 cents. Verified by feeding the synthesised
output back through the app's own detector.

### Auto-advance follows the player

After a string settles in tune, the app waits briefly and moves to the next one. Direction is
inferred rather than assumed: starting at the 6th string walks toward the 1st, starting at
the 1st walks toward the 6th, and switching strings mid-session re-reads the direction from
that move.

The first implementation only advanced if the string stayed inside ±4 cents continuously for
the whole delay. A decaying note almost always wobbles out of that band for a moment, which
silently cancelled the transition — so it appeared to work once and then never again. The
timer now runs independently of the signal and is only abandoned if the reading moves more
than 15 cents, i.e. when the player has clearly gone back to the tuning peg.

### The catalogue was quietly ASCII-only

Importing the Russian scene surfaced a bug that would have destroyed the data without
raising a single error. Deduplication and slug generation both normalised titles with
`[^a-z0-9]` — which, applied to Cyrillic, returns an **empty string**. Every song by a
Russian band would have collapsed onto the same key and the same blank id, silently
reducing fifty songs to one.

The fix is Unicode-aware keys (`/[^\p{L}\p{N}]/gu`) plus transliteration for slugs, with the
song id appended when two slugs still collide. But the interesting part is what remained
afterwards, because Russian titles vary in ways an English-only importer never has to think
about:

- **ё vs е** — "Он Не Придет" and "Он не придёт" are the same song, and they arrived with
  two different tunings
- **script variance** — "Осколки"/"Oskolki", "Сид Spears"/"Sid Spears"
- **inconsistent transliteration** — "12 Секунд" vs "12 Secund", where a strict transliterator
  produces *sekund* and *secund*

Eight duplicate pairs survived the automated pass and were caught by comparing
aggressively-normalised keys with k/c and y/i folded together. Two of the eight disagreed on
the tuning, so they became conflict entries rather than being silently merged.

### Low is not the same as wrong

The same import produced a batch of unusually low tunings, and the temptation was to treat
low as suspect. Some were genuinely broken: an entry whose lowest strings were E1 and A1 —
bass guitar range — turned out to be a bass track that slipped past the guitar filter. A
title with a transcriber's credit baked into it ("... by Music Master Тула") carried a
tuning that was just standard with one string wrong. A Nirvana cover was filed under the
covering band's own catalogue.

But [AMATORY]'s six-string Drop G, tuned down to G1 at 49 Hz, is real — five songs, all
consistent — and so is Stigmata's seven-string Drop G. The distinguishing signal was not the
pitch but the consistency: a real band tuning recurs across songs, while an artefact appears
once. This is the same lesson as the unison heuristic above, arriving from the opposite
direction.

### Data honesty over false precision

Tuning information on the internet contradicts itself constantly, so every catalogue entry
carries a confidence level and its sources. `high` means cross-checked across multiple
independent sources and shown with a verified badge in the UI. Entries without that badge
are omitted from the display to avoid labelling 99% of the library as unverified noise.

Where sources genuinely disagree, both readings ship as selectable variants instead of one
being silently chosen. Metallica's "The Thing That Should Not Be" is transcribed as D
standard, as Drop D, and Kirk Hammett has been quoted saying C#. The same mechanism covers
songs with legitimately different studio and live tunings, such as Nirvana's "Come As You
Are" — D standard on the record, E♭ live.

One further signal is recorded rather than hidden. When every transcription of a band's
catalogue reports an identical tuning with no variation at all, that is as likely to mean
transcribers copied the value forward as it is to mean the band never retuned. Those entries
carry a note saying so. It is a weaker claim than the data appears to make, and saying so is
more useful than sounding certain.

---

## Data model

A tuning is an ordered array of scientific-pitch note names, low to high, of any length:

```json
{
  "id": "drop-b",
  "name": "Drop B",
  "strings": ["B1", "F#2", "B2", "E3", "G#3", "C#4"]
}
```

Nothing in the detector, the UI or the storage layer assumes six strings. Seven- and
eight-string guitars, bass and ukulele work without schema changes, and the custom tuning
builder already offers 4 through 8. The catalogue exercises this today: the Keith Richards
open G entry is genuinely five strings, because he removes the sixth.

Songs don't repeat the note array — they reference a tuning by id:

```json
{
  "song": "Vermilion Pt. 2",
  "artist": "Slipknot",
  "t": "drop-b",
  "sid": 438900
}
```

That normalisation matters at this scale. 3,500 songs share only 144 distinct tunings, and
roughly half of the original file was repeated boilerplate prose and reconstructible URLs.
Collapsing both took the catalogue from 300 KB to 84 KB before the bulk import, and the
finished file is 618 KB raw but **91 KB gzipped** — small enough to ship whole, so search
stays instant and the entire library works offline.

Splitting the catalogue into per-artist chunks was considered and rejected: searching for a
song requires an index of every title anyway, and chunking would break offline use for
anything not already downloaded. Extrapolated, one normalised file holds 25,000 songs in
about 280 KB gzipped.

---

## Stack

| | |
|---|---|
| Audio | Web Audio API — AnalyserNode, custom DSP in plain JS |
| Rendering | Canvas 2D, spring-smoothed at 60fps |
| Offline | Service worker, network-first with cache fallback |
| Storage | localStorage, with JSON export/import as a backup path |
| Data | Static `tunings.json`, 3,500 songs in 91 KB gzipped |
| Deploy | GitHub Pages |

Network-first caching is deliberate: a cache-first shell would pin installed users to a stale
build. On GitHub Pages there are no cache headers to tune, so bumping the service worker
version each deploy is the only lever that matters.

## Running locally

```bash
git clone https://github.com/marr59/guitar-tuner.git
cd guitar-tuner
python3 -m http.server 8000
```

Then open `http://localhost:8000`. Microphone access needs a secure context, so `localhost`
works but a bare LAN IP will not — use HTTPS to test from a phone.

## Contributing a tuning

Entries live in `tunings.json`. Include the strings low to high, the source you checked, and
an honest confidence level. If a song is played in plain E standard, it doesn't need an entry.

## Data sources

A large part of the tuning catalogue was imported from the
[Songsterr](https://www.songsterr.com) public catalogue API. Only tuning
metadata (which notes the strings are tuned to) is stored — no tablature,
no notation, no audio. Each imported entry links back to the original
Songsterr tab page so you can cross-check the source directly.

The app is free, has no ads and no subscription, so this is
non-commercial use. Attribution is displayed in the UI next to every
entry that came from their catalogue, and permission for this use has
been requested from Songsterr directly.

## License

MIT — see [LICENSE](LICENSE).
