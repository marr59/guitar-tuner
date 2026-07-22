# Guitar Tuner

A fast, free guitar tuner with a library of alternate tunings for specific songs.

**Live: [tuner.artofrental.com](https://tuner.artofrental.com)**

Pick a song, see the tuning it was recorded in, retune, play. No account, no signup,
no paywall. Works offline once installed.

![Guitar Tuner](icon-512.png)

---

## Why this exists

Most tuners handle E standard and a handful of drop tunings. The annoying part of
playing metal isn't the tuning itself, it's *finding out* which tuning a song uses,
which usually means digging through tab sites and forum threads that contradict each
other.

Slipknot's "Vermilion Pt. 2" is the example that started this project. Most published
tabs are written in E standard because it's easier to read that way. The record is in
Drop B. If you trust the tabs, you learn the song in the wrong key.

So the app pairs an accurate tuner with a curated database of *alternate* tunings,
tied to specific songs and albums. Songs that are just plain E standard are
deliberately left out: their absence is itself useful information.

---

## Engineering notes

No frameworks, no build step, no backend. One HTML file, one JSON catalogue, a service
worker. That was a constraint worth keeping: it deploys with `git pull` and it runs on
a phone in a rehearsal room with no signal.

### Pitch detection is target-constrained

The naive approach — detect whatever note is playing, then figure out which string it
is — turns out to be the wrong design. In low tunings like Drop B the strings are close
enough together, and rich enough in harmonics, that the detector regularly locks onto a
neighbouring string or an octave harmonic.

Instead the user picks the string first. Because the target frequency is then known,
the detector only has to answer "how far is this from *that* note", and it can restrict
its period search to ±700 cents around the expected one. Octave errors and
neighbour-string confusion stop being possible, rather than being fought with
heuristics.

The detector itself is a YIN-style cumulative difference function with a coarse pass
followed by a fine pass, plus parabolic interpolation of the minimum. Measured against
synthetic plucked-string signals: **better than 0.15 cents** across the F#1 to E4 range,
including strings detuned by up to 180 cents.

### The needle holds instead of guessing

The difference function also yields an aperiodicity figure, which becomes a confidence
score. On a cleanly plucked string it sits at 0.98, on a noisy but valid signal 0.82, on
room noise 0.10, and on silence 0.00.

Below a threshold of 0.55 the reading is discarded and the needle **holds its last
position** rather than darting around. Combined with a median filter over recent
readings and an exponential glide rendered at 60fps independently of the analysis rate,
this is what makes the display feel calm instead of nervous.

### Reference tones are physically modelled

Tapping a string plays a reference pitch. The first version stacked five sine partials
under a shared envelope and sounded like a whistle, because real strings don't decay
uniformly — high harmonics die much faster than low ones.

The current version is a Karplus-Strong plucked string: a filtered noise burst
circulating through a delay line, comb-filtered at the pick position, voiced through a
light body EQ. It sounds like a string because it's simulating one, and it costs zero
extra bytes of audio assets.

One catch worth recording: the delay line length has to be *fractional*. Rounding it to
whole samples put the pitch up to **15.7 cents off** — which would be worse than useless
in a tuner, since you'd tune your guitar to a lie. A first-order allpass section supplies
the fractional part, bringing the error under 0.1 cents. Verified by running the
synthesised output back through the app's own detector.

### The tuning model has no fixed string count

A tuning is an ordered array of scientific-pitch note names, low to high, of any length:

```json
{ "id": "drop-b", "name": "Drop B", "strings": ["B1","F#2","B2","E3","G#3","C#4"] }
```

Nothing in the detector, the UI, or the storage layer assumes six strings. Seven- and
eight-string guitars, bass and ukulele work without schema changes, and the custom
tuning builder already offers 4 through 8. The catalogue exercises this today: the Keith
Richards open G entry is genuinely five strings, because he removes the sixth.

### Data honesty over false precision

Tuning information on the internet contradicts itself constantly, so every catalogue
entry carries a confidence level and its sources. `high` means cross-checked across
multiple independent sources; `medium` means commonly cited but worth confirming by ear,
and the UI labels it as unverified.

Where sources genuinely disagree — Metallica's "The Thing That Should Not Be" is
transcribed as D standard, as Drop D, and Kirk Hammett has been quoted saying C# — both
readings ship as selectable variants instead of one of them being silently chosen. The
same mechanism covers songs with legitimately different studio and live tunings, like
Nirvana's "Come As You Are" (D standard on the record, Eb live).

---

## Stack

| | |
|---|---|
| Audio | Web Audio API — AnalyserNode, custom DSP in plain JS |
| Rendering | Canvas 2D, spring-smoothed at 60fps |
| Offline | Service worker, network-first with cache fallback |
| Storage | localStorage, with JSON export/import as a backup path |
| Data | Static `tunings.json` served by nginx |
| Deploy | Static files behind nginx and Cloudflare |

Network-first caching is deliberate: the site deploys by `git pull`, so a cache-first
shell would pin installed users to a stale build.

## Running locally

```bash
git clone https://github.com/marr59/guitar-tuner.git
cd guitar-tuner
python3 -m http.server 8000
```

Then open `http://localhost:8000`. Microphone access needs a secure context, so
`localhost` works but a bare LAN IP will not — use HTTPS if you want to test from a
phone.

## Contributing a tuning

Entries live in `tunings.json`. Include the strings low to high, the source you checked,
and an honest confidence level. If a song is played in plain E standard, it doesn't need
an entry.

## License

MIT
