# Zero Race

A racing broadcast you can only watch.

Eight cars, four colours, one circuit. You pick a colour and you cheer — but
nothing you do changes the result. That's the whole point, and it's where the
name comes from: your input on the race is exactly zero.

What you *can* change is the **next** race. Every round hands out development
points, and the viewers decide where they go.

---

## The idea

Every race is generated from a **seed**. The seed decides the circuit, the
weather, the tyre strategies, the incidents and the result — completely, down
to the millisecond. Nothing is left to chance at playback time.

That determinism is what makes the show work:

```
seed
 ├─▶ Track.generate(seed)          the circuit
 ├─▶ Sim.runHeadless(seed)         the WHOLE race, simulated in ~400 ms
 │     └─▶ timestamped event log   every overtake, pit stop, spin, weather change
 │           └─▶ EventLog.analyse  hindsight scoring; marks passes that get reversed
 │                 ├─▶ Commentary  writes AND schedules every line, in advance
 │                 └─▶ Camera      picks the moments worth a close-up
 └─▶ Sim.create(seed)              the same race again, this time in real time
       └─▶ lands on identical events at identical timestamps
```

The commentator therefore knows the future, and it uses that twice.

**For accuracy.** When a car takes the lead on lap 9 it can say *"and that,
right there, is the move that wins this race"* — the pass has already been
checked against the final classification. Conversely, when a pass is about to
be reversed two seconds later, it says *"Red is through — but I don't think
that's settled!"* instead of announcing a lead change the viewer can already
see being undone.

**For pacing.** Every line's spoken length is estimated and the whole broadcast
is laid out offline: the most important moments claim their slot first, the rest
fit in the gaps or are dropped. The announcer therefore never talks over itself,
however many things happen at once — there is nothing to interrupt, because the
schedule has no overlaps by construction.

The live run is verified against the pre-simulation: both produce identical
event logs.

## Running it

It's plain static files — no build step, no dependencies.

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Click **START BROADCAST** (browsers require one user gesture before audio and
speech can play).

### URL parameters

| Parameter | Example | Meaning |
|---|---|---|
| `seed` | `?seed=ZR-1A2B3C4` | Replay an exact race. Any word works too (`?seed=monaco`). |
| `laps` | `?laps=20` | Race distance. |

The URL updates itself whenever a new race starts, so the address bar is always
a shareable link to the race on screen.

### Keyboard

| Key | Action |
|---|---|
| `H` | Show/hide the control room (hide it before recording) |
| `Space` | Pause / resume |
| `N` | New race |
| `C` | Toggle the broadcast camera (off = static wide shot) |

Hovering the top-left corner reveals the track editor: show and drag the
control points to reshape the circuit by hand.

---

## What happens during a race

**Qualifying.** All eight cars run alone, spread around the lap: one warm-up
lap and one timed lap. The out-lap is fast-forwarded; the flying lap — the only
part that decides anything — runs in real time. Fastest sets pole.

**The race.** 10 laps by default (about three and a half minutes), with:

- **Tyres.** Soft / medium / hard, plus intermediates and full wets. Grip is
  `compound × wear × surface × damage`, and it drives corner speed *and*
  braking — a worn tyre in the rain is slow and hard to stop, which is exactly
  when the overtakes happen. Each car picks a strategy by weighing pit-stop
  time against compound pace.
- **Strategy.** Every car plans its race on the grid: how many stops, on which
  compounds, on roughly which laps — scored by total race time, weighing pit
  loss against compound pace, with the aggressive drivers discounting stops.
  The plan then reacts: a safety car makes a stop cheap and brings people in
  early, rain forces a compound change, and a car being undercut by the rival
  in front will pit to defend. The stops-made/planned figure sits in the
  timing tower.
- **Pit stops.** A proper pit lane: a through-road ("fast lane") running
  alongside the start/finish straight, with eight marked bays behind it and the
  garage frontage behind those. Cars brake for the speed-limit line while still
  on the circuit, run down the fast lane, pull across into their own bay to be
  serviced, and rejoin. They queue nose to tail on the fast lane; a car already
  in its bay is out of the way and does not hold the queue up. Stop time depends
  on the team's pit crew upgrade, plus repairs if the car is damaged.
- **DRS.** Detection points before each long straight. Within one second of the
  car ahead, the rear wing opens: +14% top speed through the zone. Disabled in
  the wet and under the safety car.
- **Weather.** The forecast is rolled from the seed: dry, rain arriving
  mid-race, a wet start that dries out, or a passing shower. Track wetness soaks
  up fast and dries slowly, so there's always a crossover point where the whole
  field has to gamble.
- **Safety car.** A big enough incident bunches the field back up and turns the
  race into a sprint.
- **Damage and reliability.** Contact costs performance; enough of it forces a
  repair stop or ends the race. Mechanical failures are rolled per lap against
  the team's reliability rating.
- **Boost pads and oil slicks.** The arcade layer, kept from the original build.
  Pads only light up in the stretch of track that still has cars on it, and the
  leader can never take one, so they work purely as catch-up.

**Broadcast camera.** Planned, not reactive. Because the race is already
simulated, the director picks the ten-or-so moments worth a close-up *before*
the first frame is drawn and schedules them, so the camera eases in a second and
a half **ahead** of the move — exactly like a real operator already standing in
the corner. It holds through the moment, then eases back out. The resting state
is the full-circuit wide shot.

Cutting to all forty overtakes, which is what the first version did, reads as a
strobe light. One considered close-up every fifteen seconds reads as television.

---

## The YouTube loop

This is the part that makes it a series rather than a screensaver.

1. **Record a race.** Press `H` to hide the control room; everything else is
   drawn on the canvas, so the capture is clean.
2. **Publish it.** The results screen is four full-screen cards on a rotation —
   winner, classification, honours, then the call to action — every size
   expressed in units of screen height, so it stays readable on a phone held
   sideways. The last card lists the development points each team earned and
   exactly what to comment.
3. **Collect the votes.** Viewers comment a team and an upgrade — `RED brakes`,
   `green tyres`, `blue engine`.
4. **Apply them.** Open the control room → *Viewer votes*, paste the comments,
   press **TALLY & APPLY VOTES**. Every line naming exactly one team and one
   upgrade counts; each team then spends its bank on its most-voted upgrade
   until it runs out of points.
5. **Race again.** The teams now differ, and they keep diverging every round.

### Development points

| Achievement | Points |
|---|---|
| Race win | 5 |
| P2 / P3 | 3 / 2 |
| Any other finish | 1 |
| Fastest lap | 3 |
| Most overtakes | 3 |
| Most boost pads | 2 |
| Cleanest race (fewest incidents) | 2 |

Championship points use the familiar 10-8-6-5-4-3-2-1 table and are tracked
separately.

### Upgrades

| Upgrade | Effect per level |
|---|---|
| Engine | +1.8% top speed |
| Gearbox | +3.0% acceleration |
| Brakes | +2.8% braking |
| Aero | +2.4% cornering |
| Tyre Management | −7% tyre wear |
| Pit Crew | −7.5% stop time |
| Reliability | −13% failure chance, −9% damage taken |
| Wet Setup | +3% grip per unit of track wetness |

Six levels each, costing 2, 4, 6, 8, 10, 12 points. The whole season lives in
`localStorage` on the machine that runs the broadcast, so keep using the same
browser profile — or press **RESET SEASON** to start over.

### Recording notes

- Sound effects and the engine bed are synthesised in WebAudio, which browser
  tab capture records normally.
- The announcer uses the Web Speech API. On some browsers that audio is *not*
  picked up by tab capture — record **desktop audio** (OBS: "Desktop Audio"
  source) rather than tab audio, and you'll get both.
- Subtitles are always drawn, so the broadcast still reads perfectly with the
  sound off.
- Pick a voice in the control room; a British English voice sounds most like a
  race feed. Availability depends on the OS.

---

## Files

| File | Role |
|---|---|
| `rng.js` | Seeded PRNG (mulberry32), seed codes, independent sub-streams |
| `track.js` | Procedural circuit, straight/DRS/sector/pit analysis, rendering |
| `camera.js` | Broadcast director: builds the shot plan, eases in and out |
| `weather.js` | Forecast rolled from the seed, rain vs. track wetness |
| `car.js` | Physics, tyres, damage, DRS, pit-lane state machine, racing AI |
| `powerups.js` | Boost pads, oil slicks, passive catch-up |
| `events.js` | Timestamped event log, hindsight scoring, cluster thinning |
| `sim.js` | The deterministic simulation; qualifying, race, safety car, results |
| `commentary.js` | Line templates, offline scheduling, Web Speech announcer |
| `hud.js` | Timing tower, lap counter, minimap, subtitles, captions, ticker |
| `effects.js` | Skid marks, spray, smoke, sparks, confetti, rain overlay |
| `audio.js` | Procedural WebAudio engine bed and sound effects |
| `upgrades.js` | Garage: catalog, points, vote parsing, season persistence |
| `race.js` | Show orchestration: phases, event playback, results and CTA screen |
| `sidebar.js` | The control-room DOM panel |
| `editor.js` | Track editor overlay |
| `main.js` | Canvas sizing, render loop, wiring |

Everything runs in the browser. There is no server, no build, and no network
call at runtime.

### The circuit is bigger than the screen

Tracks are generated at 1.55× the viewport. A circuit confined to the screen has
to be either oval-shaped or made of corners too tight to drive — there is simply
nowhere to put a real sequence of bends. The wide shot scales the whole thing to
fit; the director's close-ups are what the extra resolution is for.

### Keeping it deterministic

If you extend the simulation, the one rule that matters: **anything that
affects the race must draw from the seeded stream** (`ctx.rng`, `this._rng`),
and anything cosmetic (particles, camera, grass texture) must not. Cosmetic
code is free to use `Math.random()` — it never feeds back in, and it is
switched off entirely during the headless pre-run.

The simulation always advances in fixed 1/60 s steps. The render loop only
decides *how many* steps to run for the wall-clock time that has passed.
