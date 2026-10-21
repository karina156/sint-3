# web synthesizer — geometric performance

Interactive poster + experimental instrument. Every geometric shape on the screen is a voice;
moving shapes rearranges both the picture and the music.

**Run:** open `index.html` in a browser (works from `file://` or any static server).
Click any shape to start the sound.

## The idea: order and breath

The square family is **metre** — Euclidean rhythms and polymeter.
The circle family is **breath** — a just-intonation pad and a motif that develops.
The poster is the **score**: where a shape sits decides what it plays.
Shapes that touch create friction; shapes that merge become consonant.
When the last voice stops, the piece resolves on a tonic chord.

## Controls

| Shape | Click / tap | Drag | Extra |
|---|---|---|---|
| Big circle | soft pad on/off | move — its height picks the progression (bright / home / dark) | turn the arrow around the centre → timbre (up = middle, clockwise = brighter); vertical slider / wheel → volume |
| Green oval (child of circle) | motif on/off | move | arrow length → phrase length (3–8 notes) + volume; the arrow never leaves the oval |
| Green square | percussion on/off | move — column shifts the rhythm | frames: 1 = tresillo E(3,8), 2 = cinquillo E(5,8), 3 = E(11,16) |
| Blue rectangle (child of square) | glitch voice on/off | move — column shifts the rhythm | frames: polymeter E(2,5) / E(3,7) / E(5,9) against the square's 16 |
| Orange capsule | front = doubler on/off, back = double the selected voice | move | |
| Small pink circles | three interlocking cells (hocket): blip / beep / chirp | move — column shifts the cell | |
| Corners | `+` play · `-` pause · `k` all off (resolves) · `z` shapes home | | |

Every switch lands on the **next beat** — the shape blinks until it enters.

## Sound

- **Harmony:** D Dorian, 108 BPM, a chord every 2 bars. The pad is tuned in just intonation
  (3:2, 6:5 / 5:4, 9:4 over the chord root); energy adds the ninth.
- **The poster as a score:** x → stereo pan and rhythmic rotation (by grid column);
  y → register (upper / middle / lower third of the poster) and depth (higher = more reverb).
- **Hybrids:** after you have moved a shape, overlapping a sounding voice creates a hybrid.
  Its interval glides 16:15 → 9:8 → 4:3 → 3:2 as the overlap grows (full at ~35 %),
  and ring modulation gives way to a clean interval.
- **Space:** generated 3.4 s convolution reverb, ping-pong delay on the dotted eighth,
  the square ducks the pad (sidechain), soft tanh saturation → gentle compressor → AnalyserNode.
- **Form:** while two or more voices play together, energy builds bar by bar and opens the
  mix (brighter master filter, longer reverb and delay). `k` or switching the last voice off
  plays the closing chord.
- The background grid reacts to the real output level (AnalyserNode).

## Stack

HTML · CSS · vanilla JS · Web Audio API · Canvas (grid). No libraries.

| File | Role |
|---|---|
| `scripts/audio.js` | Web Audio engine: transport, harmony, voices, space, hybrids, energy, analyser |
| `scripts/ui.js` | Figma geometry, DOM build, desktop/mobile layouts, arrows, rendering |
| `scripts/interactions.js` | pointer gestures, spring / inertia physics, intro nudge |
| `scripts/collisions.js` | convex-polygon overlap (Sutherland–Hodgman) |
| `scripts/grid.js` | audio-reactive grid on Canvas |
| `scripts/app.js` | state, instrument logic, poster-as-score mapping, screen manager, main loop |

Font: Evolventa (OFL), bundled in `fonts/`.
