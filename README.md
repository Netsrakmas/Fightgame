# Micro Wars

A pocket-sized, mobile-first turn-based tactics game in the spirit of Advance Wars.
Pure HTML5/JavaScript — no build step, no dependencies, works offline as a PWA.

![genre](https://img.shields.io/badge/genre-turn--based%20tactics-orange)
![platform](https://img.shields.io/badge/platform-mobile%20%2B%20desktop%20web-blue)

## Play

Serve the folder with any static server and open it on your phone or desktop:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

On a phone, use **Add to Home Screen** for fullscreen offline play.

## Features

- **Campaign** — 5 missions with escalating mechanics (movement → armor & artillery → economy & transports → air war → combined arms finale)
- **Skirmish** — 5 hand-built maps vs the AI, or 2-player hotseat on one device
- **Fog of War** option with true vision rules (woods hide, mountains extend sight, ambushes interrupt movement)
- **13 unit types** — infantry, mechs, recon, tanks, medium tanks, APCs, artillery, rockets, anti-air, fighters, bombers, battle & transport copters
- **Advance-Wars-style rules** — terrain defense stars, damage chart, counterattacks, capture points, per-property income, base/airport production, repairs, unit joining, transports
- **A real AI opponent** — evaluates attacks vs counter-risk, captures, retreats to repair, ferries infantry across water with transport copters, and builds counter-units
- **Touch-first UI** — tap to select/move/act, pinch to zoom, drag to pan, damage forecasts before you commit, enemy threat ranges, next-ready-unit button, AI fast-forward
- **Procedural everything** — all sprites are drawn in code, all sound is synthesized WebAudio; zero asset files
- **Auto-save** — close the tab mid-battle and continue later; campaign progress is remembered
- **PWA** — installable, fully offline after first load

## How to play

Capture the enemy HQ or destroy all enemy units.

- Tap a unit → blue tiles show its range → tap a tile → choose an action.
- Infantry/Mechs **capture** properties; each property pays **1,000G** per day.
- Tap your **Base/Airport** to build units with those funds.
- Woods/mountains give defense ★; artillery can't move and fire the same turn; anti-air deletes copters; bombers delete ground.
- End a turn on a friendly property to repair 2 HP (costs funds).

## Development

```
js/data.js    unit/terrain/damage tables
js/maps.js    skirmish maps + campaign missions
js/engine.js  rules engine (pure, node-testable)
js/ai.js      AI player (pure, node-testable)
js/render.js  canvas renderer, procedural sprites
js/audio.js   WebAudio SFX + chiptune loops
js/main.js    UI state machine, input, screens
tests/test.js headless test suite
```

Run the tests (validates maps, rules, and full AI-vs-AI games on every map):

```bash
node tests/test.js
```
