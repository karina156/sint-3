# web synthesizer — geometric performance

Interactive poster + experimental instrument. Every geometric shape on the screen is a voice;
moving shapes rearranges both the picture and the music.

**Run:** open `index.html` in a browser (works from `file://` or any static server).
Click any shape to start the sound.

## Controls
| Shape | Click / tap | Drag | Extra |
|---|---|---|---|
| Big circle | soft pad on/off | move | slide the arrow along its axis → timbre; vertical slider / wheel → volume |
| Green oval (child of circle) | arpeggio on/off | move | arrow length → volume |
| Green square | percussion on/off | move | frames around it: 1 / 2 / 3 layers → denser beat |
| Blue rectangle (child of square) | glitch voice on/off | move | frames: density, ratchets, pitch jumps |
| Orange capsule | front = doubler on/off, back = double the selected voice | move | |
| Small pink circles | blip / beep / chirp loops | move | |
| Corners | `+` play · `-` pause · `k` all off · `z` shapes home | | |

Overlapping shapes (after you have moved one of them) create a hybrid ring-modulated voice that
fades in from first contact and opens fully at ~35 % overlap.
The background grid reacts to the real output level (AnalyserNode).

## Stack
HTML · CSS · vanilla JS · Web Audio API · Canvas (grid). No libraries.

| File | Role |
|---|---|
| `scripts/audio.js` | Web Audio engine: transport, voices, doubler, hybrids, analyser |
| `scripts/ui.js` | Figma geometry, DOM build, desktop/mobile layouts, rendering |
| `scripts/interactions.js` | pointer gestures, spring / inertia physics, intro nudge |
| `scripts/collisions.js` | convex-polygon overlap (Sutherland–Hodgman) |
| `scripts/grid.js` | audio-reactive grid on Canvas |
| `scripts/app.js` | state, instrument logic, screen manager, main loop |

Font: Evolventa (OFL), bundled in `fonts/`.
