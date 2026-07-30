/**
 * Race — the broadcast layer.
 *
 * Owns the show, not the simulation. The flow is:
 *
 *   1. generate the circuit from the seed
 *   2. run the whole race headless (Sim.runHeadless) — a few hundred ms
 *   3. hand the resulting event log to the commentator, who writes every line
 *      in advance, with hindsight
 *   4. re-run the same seed in real time and play the show against it
 *
 * Because step 4 is deterministic it lands on exactly the same events at
 * exactly the same times as step 2.
 */
const Race = (() => {

    const STEP_MS = 1000 / 60;

    const PHASES = {
        LOADING:      'loading',
        PREVIEW:      'preview',
        QUAL_INTRO:   'qual_intro',
        QUALIFYING:   'qualifying',
        QUAL_RESULT:  'qual_result',
        GRID:         'grid',
        COUNTDOWN:    'countdown',
        RACE:         'race',
        COOLDOWN:     'cooldown',
        RESULTS:      'results',
    };

    let sim = null;
    let preSim = null;           // { result, events, qualifying }
    let seed = 0;
    let phase = PHASES.LOADING;
    let phaseTimer = 0;
    let accumulator = 0;
    let eventCursor = 0;
    let speedMultiplier = 1;
    let awarded = null;          // Garage breakdown, computed once at the flag
    let totalLaps = 10;
    let raceNumber = 1;
    let onResults = null;
    let paused = false;

    const PREVIEW_MS   = 5200;
    const QUAL_INTRO_MS = 2600;
    const QUAL_RESULT_MS = 8600;
    const COUNTDOWN_MS = 5200;
    const COOLDOWN_MS  = 7000;
    const QUAL_WARMUP_SPEED = 5.0;   // out-lap only; the flying lap runs 1:1

    // -------------------------------------------------------------------------
    // Setup
    // -------------------------------------------------------------------------

    /**
     * @param {number} newSeed
     * @param {object} opts { worldW, worldH, totalLaps, onTrackReady, onResults }
     */
    function init(newSeed, opts = {}) {
        seed = newSeed >>> 0;
        totalLaps = opts.totalLaps || totalLaps;
        raceNumber = Garage.getRaceNumber();
        onResults = opts.onResults || null;
        awarded = null;

        // 1. Circuit — its own stream so changing lap count never changes the layout.
        Track.generate(opts.worldW, opts.worldH, Rng.create((seed ^ 0x5f3a7c11) >>> 0));
        if (opts.onTrackReady) opts.onTrackReady();
        Hud.reset();

        // 2. Headless pre-simulation — the whole race, before we draw a frame.
        const mods = Garage.snapshotModifiers();
        Effects.setEnabled(false);
        preSim = Sim.runHeadless(seed, { totalLaps, mods });
        Effects.setEnabled(true);
        console.log(`[zero-race] pre-simulated ${preSim.steps} steps in ${preSim.elapsedMs.toFixed(0)} ms — ` +
                    `${preSim.events.length} events, winner ${preSim.result.standings[0].name}`);

        // 3. Write the commentary from the finished story.
        Commentary.load(preSim.events, {
            seed, trackName: Track.getName(), totalLaps,
            duration: preSim.result.duration,
        });
        Commentary.setLiveProvider(getLive);

        // 3b. Plan the camera the same way: pick the handful of moments worth
        //     a close-up, well ahead of time, instead of chasing every pass.
        const shots = Camera.buildPlan(preSim.events, preSim.result.duration);
        console.log(`[zero-race] camera plan: ${shots.length} close-ups over ` +
                    `${(preSim.result.duration / 1000).toFixed(0)}s`);

        // 4. The live run.
        sim = Sim.create(seed, { totalLaps, mods, effects: true });

        phase = PHASES.PREVIEW;
        phaseTimer = 0;
        accumulator = 0;
        eventCursor = 0;
    }

    // -------------------------------------------------------------------------
    // Update
    // -------------------------------------------------------------------------

    function update(dtMs) {
        const dt = dtMs / 1000;
        if (!sim) return;

        // While paused the show stops but the camera keeps easing, so the
        // frozen frame still looks like a broadcast rather than a crash.
        if (paused) {
            Effects.update(dt);
            Camera.update(dt, {
                cars: sim.cars, order: sim.state.order || sim.cars,
                simTime: sim.state.simTime, wide: false,
            });
            return;
        }

        phaseTimer += dtMs;

        switch (phase) {
            case PHASES.PREVIEW:
                Camera.goWide();
                if (phaseTimer > PREVIEW_MS) _to(PHASES.QUAL_INTRO);
                break;

            case PHASES.QUAL_INTRO:
                if (phaseTimer > QUAL_INTRO_MS) {
                    _to(PHASES.QUALIFYING);
                    Commentary.say(`Qualifying at ${Track.getName()}. One flying lap each — the grid is on the line.`, 95);
                }
                break;

            case PHASES.QUALIFYING: {
                // Fast-forward the out-lap, then drop to real time so the
                // flying lap — the only part that decides anything — is
                // actually watchable.
                const onFlyingLap = sim.cars.some(c => !c.qualifyingDone && c._qualPhase >= 1);
                _advance(dtMs, (onFlyingLap ? 1 : QUAL_WARMUP_SPEED) * speedMultiplier);
                if (sim.phase === 'grid') {
                    _to(PHASES.QUAL_RESULT);
                    const pole = sim.state.qualifyingResults[0];
                    if (pole) Commentary.say(`${pole.car.speechName} takes pole position with a ${(pole.lapTime / 1000).toFixed(2)}.`, 95);
                }
                break;
            }

            case PHASES.QUAL_RESULT:
                Camera.goWide();
                if (phaseTimer > QUAL_RESULT_MS) _to(PHASES.COUNTDOWN);
                break;

            case PHASES.COUNTDOWN: {
                const prev = Math.ceil((COUNTDOWN_MS - phaseTimer + dtMs) / 1000);
                const now = Math.ceil((COUNTDOWN_MS - phaseTimer) / 1000);
                if (now !== prev && now > 0 && now <= 5) Audio2.SFX.beep();
                if (phaseTimer > COUNTDOWN_MS) {
                    Audio2.SFX.go();
                    sim.beginRace();
                    _to(PHASES.RACE);
                }
                break;
            }

            case PHASES.RACE:
                _advance(dtMs, speedMultiplier);
                _playEvents();
                if (sim.phase === 'finished') {
                    _to(PHASES.COOLDOWN);
                    const w = sim.state.finishOrder[0];
                    if (w) {
                        Effects.addConfetti(w.x, w.y, 140);
                        Camera.spotlight([w], 6, 'THE WINNER');
                    }
                }
                break;

            case PHASES.COOLDOWN:
                _advance(dtMs, speedMultiplier);   // let the tail of the field roll on
                _playEvents();
                if (phaseTimer > COOLDOWN_MS) {
                    _to(PHASES.RESULTS);
                    _award();
                }
                break;

            case PHASES.RESULTS:
                Camera.goWide();
                break;
        }

        // Fade finished and retired cars out so the track empties gracefully.
        for (const c of sim.cars) {
            if (c.retired && c._finishFadeDelay === 0 && c._finishAlpha === 1) c._finishFadeDelay = 3500;
            if (!c._finishedRace && !c.retired) continue;
            if (c._finishFadeDelay > 0) c._finishFadeDelay -= dtMs;
            else c._finishAlpha = Math.max(0, c._finishAlpha - dtMs / 1400);
        }

        Effects.update(dt);
        Commentary.update(sim.state.simTime, phase === PHASES.RACE || phase === PHASES.COOLDOWN);

        Camera.update(dt, {
            cars: sim.cars,
            order: sim.state.order || sim.cars,
            simTime: sim.state.simTime,
            wide: phase === PHASES.PREVIEW || phase === PHASES.QUAL_RESULT ||
                  phase === PHASES.RESULTS || phase === PHASES.QUAL_INTRO,
        });

        _updateAudio();
    }

    function _to(p) { phase = p; phaseTimer = 0; }

    function _advance(dtMs, speed) {
        accumulator += dtMs * speed;
        let steps = 0;
        const MAX_STEPS = 40;    // never let a stalled tab try to catch up forever
        while (accumulator >= STEP_MS && steps < MAX_STEPS) {
            sim.step();
            accumulator -= STEP_MS;
            steps++;
            if (sim.phase === 'grid' || sim.phase === 'finished') break;
        }
        if (steps >= MAX_STEPS) accumulator = 0;
    }

    /** Fire the pre-simulated events as the clock reaches them. */
    function _playEvents() {
        const t = sim.state.simTime;
        const evts = preSim.events;
        while (eventCursor < evts.length && evts[eventCursor].t <= t) {
            const e = evts[eventCursor++];
            Hud.onEvent(e);
            Audio2.playForEvent(e.type, e.data);
            _directorCut(e);
        }
    }

    /**
     * The camera already knows what is coming (Camera.buildPlan), so events do
     * not steer it any more — cutting on all forty overtakes was what made the
     * broadcast strobe. All an event does here is rattle the frame.
     */
    function _directorCut(e) {
        const d = e.data || {};
        if (e.type === 'crash') Camera.shake(9 + (d.severity || 0) * 12);
        else if (e.type === 'contact') Camera.shake(5);
        else if (e.type === 'spin') Camera.shake(4);
        else if (e.type === 'dnf') Camera.shake(7);
    }

    function _updateAudio() {
        const subs = Camera.getSubjects();
        const ref = subs[0] || sim.state.leader;
        const running = phase === PHASES.RACE || phase === PHASES.QUALIFYING || phase === PHASES.COOLDOWN;
        if (!running || !ref) { Audio2.engineOff(); return; }
        Audio2.updateEngine(Math.min(1, ref.speed / 380), Math.min(1, (Camera.getZoom() - 1) / 2));
    }

    /** Live snapshot for the commentator's filler lines. */
    function getLive() {
        if (!sim) return null;
        return {
            order: (sim.state.order || sim.cars).filter(c => !c.retired),
            lap: sim.state.lapOfLeader,
            totalLaps: sim.state.totalLaps,
            weatherLabel: sim.weather.state.label,
        };
    }

    function _award() {
        if (awarded) return;
        awarded = Garage.applyRaceResult(preSim.result);
        if (onResults) onResults(preSim.result, awarded);
    }

    // -------------------------------------------------------------------------
    // Drawing — world space (inside the camera transform)
    // -------------------------------------------------------------------------

    function drawWorld(ctx) {
        Effects.draw(ctx);
        sim.powerUps.draw(ctx);

        const sorted = sim.cars.slice().sort((a, b) => a.totalProgress - b.totalProgress);
        for (const car of sorted) car.draw(ctx);

        if (phase === PHASES.COUNTDOWN || phase === PHASES.GRID) _drawGridMarkers(ctx);
    }

    function _drawGridMarkers(ctx) {
        for (const c of sim.cars) {
            ctx.save();
            ctx.globalAlpha = 0.85;
            ctx.translate(c.x, c.y - 40);
            ctx.fillStyle = 'rgba(0,0,0,0.6)';
            Hud.rrect(ctx, -38, -10, 76, 20, 4);
            ctx.fill();
            ctx.fillStyle = CarSVG.TEAM_COLORS[c.team].light;
            ctx.font = 'bold 11px Arial';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(c.name.toUpperCase(), 0, 0);
            ctx.restore();
        }
    }

    // -------------------------------------------------------------------------
    // Drawing — screen space
    // -------------------------------------------------------------------------

    function drawScreen(ctx, W, H) {
        const showHud = phase === PHASES.RACE || phase === PHASES.COOLDOWN ||
                        phase === PHASES.QUALIFYING || phase === PHASES.COUNTDOWN;

        Effects.drawWeather(ctx, sim.weather.state.wetness, sim.weather.state.rain, W, H, 1 / 60);

        if (showHud) Hud.draw(ctx, sim, { raceNumber });

        switch (phase) {
            case PHASES.PREVIEW:     _drawPreview(ctx, W, H); break;
            case PHASES.QUAL_INTRO:  _drawBanner(ctx, W, H, 'QUALIFYING', 'One flying lap each decides the grid', '#00d4ff'); break;
            case PHASES.QUAL_RESULT: _drawQualResults(ctx, W, H); break;
            case PHASES.COUNTDOWN:   _drawCountdown(ctx, W, H); break;
            case PHASES.RESULTS:     _drawResults(ctx, W, H); break;
        }
    }

    function _dim(ctx, W, H, alpha) {
        ctx.fillStyle = `rgba(4, 6, 20, ${alpha})`;
        ctx.fillRect(0, 0, W, H);
    }

    function _drawPreview(ctx, W, H) {
        const t = Math.min(1, phaseTimer / 500);
        const out = Math.min(1, (PREVIEW_MS - phaseTimer) / 500);
        ctx.save();
        ctx.globalAlpha = Math.min(t, out);
        _dim(ctx, W, H, 0.82);

        const cx = W / 2;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        ctx.fillStyle = '#e94560';
        ctx.font = `bold ${Math.round(58 * Hud.scale)}px Rajdhani, Arial`;
        ctx.shadowColor = '#e94560'; ctx.shadowBlur = 30;
        ctx.fillText('ZERO RACE', cx, H * 0.24);
        ctx.shadowBlur = 0;

        ctx.fillStyle = '#fff';
        ctx.font = `bold ${Math.round(30 * Hud.scale)}px Rajdhani, Arial`;
        ctx.fillText(`ROUND ${raceNumber}  ·  ${Track.getName().toUpperCase()}`, cx, H * 0.335);

        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.font = `${Math.round(17 * Hud.scale)}px Rajdhani, Arial`;
        ctx.fillText(`${totalLaps} laps   ·   ${preSim.weather}   ·   seed ${Rng.toCode(seed)}`, cx, H * 0.39);

        // Constructor line-up with current upgrade levels
        const teams = Garage.TEAMS;
        const boxW = Math.min(200 * Hud.scale, W / 5);
        const startX = cx - (teams.length * boxW) / 2;
        for (let i = 0; i < teams.length; i++) {
            const t2 = teams[i];
            const col = CarSVG.TEAM_COLORS[t2];
            const x = startX + i * boxW + boxW / 2;
            const y = H * 0.52;

            ctx.fillStyle = 'rgba(255,255,255,0.05)';
            Hud.rrect(ctx, x - boxW / 2 + 6, y - 30, boxW - 12, 150 * Hud.scale, 8);
            ctx.fill();
            ctx.fillStyle = col.main;
            ctx.fillRect(x - boxW / 2 + 6, y - 30, boxW - 12, 4);

            ctx.fillStyle = col.light;
            ctx.font = `bold ${Math.round(19 * Hud.scale)}px Rajdhani, Arial`;
            ctx.fillText(t2.toUpperCase(), x, y);

            const team = Garage.getTeam(t2);
            ctx.fillStyle = 'rgba(255,255,255,0.55)';
            ctx.font = `${Math.round(12 * Hud.scale)}px Rajdhani, Arial`;
            ctx.fillText(`${Garage.totalLevels(t2)} upgrades  ·  ${team.championship} pts`, x, y + 22 * Hud.scale);

            // Top three upgrade lines
            const top = Garage.CATALOG
                .map(u => ({ u, lvl: team.upgrades[u.id] || 0 }))
                .filter(o => o.lvl > 0)
                .sort((a, b) => b.lvl - a.lvl)
                .slice(0, 4);
            ctx.font = `${Math.round(11 * Hud.scale)}px Rajdhani, Arial`;
            top.forEach((o, k) => {
                ctx.fillStyle = 'rgba(255,255,255,0.75)';
                ctx.fillText(`${o.u.icon} ${o.u.name} ${'▮'.repeat(o.lvl)}`, x, y + (42 + k * 16) * Hud.scale);
            });
            if (!top.length) {
                ctx.fillStyle = 'rgba(255,255,255,0.28)';
                ctx.fillText('stock car', x, y + 44 * Hud.scale);
            }
        }
        ctx.restore();
    }

    function _drawBanner(ctx, W, H, title, subtitle, color) {
        const t = Math.min(1, phaseTimer / 300);
        ctx.save();
        ctx.globalAlpha = t;
        _dim(ctx, W, H, 0.55);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = color;
        ctx.shadowColor = color; ctx.shadowBlur = 26;
        ctx.font = `bold ${Math.round(46 * Hud.scale)}px Rajdhani, Arial`;
        ctx.fillText(title, W / 2, H / 2 - 16);
        ctx.shadowBlur = 0;
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.font = `${Math.round(16 * Hud.scale)}px Rajdhani, Arial`;
        ctx.fillText(subtitle, W / 2, H / 2 + 26);
        ctx.restore();
    }

    function _drawQualResults(ctx, W, H) {
        const t = phaseTimer / QUAL_RESULT_MS;
        const cx = W / 2, cy = H / 2;
        const S = Hud.scale;
        ctx.save();
        _dim(ctx, W, H, Math.min(1, t * 5) * 0.92);

        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const headerT = Math.min(1, t / 0.08);
        ctx.globalAlpha = headerT;
        ctx.fillStyle = '#00d4ff';
        ctx.shadowColor = '#00d4ff'; ctx.shadowBlur = 28;
        ctx.font = `bold ${Math.round(38 * S)}px Rajdhani, Arial`;
        ctx.fillText('QUALIFYING RESULTS', cx, cy - 215 * S);
        ctx.shadowBlur = 0;
        ctx.fillStyle = 'rgba(160,230,255,0.7)';
        ctx.font = `${Math.round(14 * S)}px Rajdhani, Arial`;
        ctx.fillText('GRID POSITIONS LOCKED IN', cx, cy - 185 * S);

        const rowH = 44 * S, rowW = 520 * S;
        const rowX = cx - rowW / 2;
        const listTop = cy - 155 * S;
        const results = sim.state.qualifyingResults;
        const best = results[0] ? results[0].lapTime : null;

        for (let i = 0; i < results.length; i++) {
            const { car, lapTime } = results[i];
            const rowT = Math.max(0, Math.min(1, (t - 0.07 - i * 0.075) / 0.08));
            if (rowT <= 0) continue;
            const ry = listTop + i * (rowH + 3 * S);
            const midY = ry + rowH / 2;

            ctx.save();
            ctx.globalAlpha = rowT;
            ctx.translate((1 - rowT) * 300, 0);

            const colors = CarSVG.TEAM_COLORS[car.team];
            const first = i === 0;

            Hud.rrect(ctx, rowX, ry, rowW, rowH, 5);
            ctx.fillStyle = first ? 'rgba(255,215,0,0.15)' : (i % 2 ? 'rgba(0,0,0,0.2)' : 'rgba(255,255,255,0.06)');
            ctx.fill();
            ctx.fillStyle = colors.light;
            ctx.fillRect(rowX, ry, 5 * S, rowH);

            ctx.textAlign = 'left';
            ctx.fillStyle = first ? '#ffd700' : 'rgba(255,255,255,0.45)';
            ctx.font = `bold ${Math.round((first ? 21 : 14) * S)}px Rajdhani, Arial`;
            ctx.fillText(`P${i + 1}`, rowX + 20 * S, midY);

            ctx.fillStyle = first ? '#fff' : colors.light;
            ctx.font = `bold ${Math.round((first ? 20 : 16) * S)}px Rajdhani, Arial`;
            ctx.fillText(car.name, rowX + 66 * S, midY);

            ctx.textAlign = 'right';
            if (lapTime) {
                if (i > 0 && best) {
                    ctx.font = `${Math.round(15 * S)}px monospace`;
                    ctx.fillStyle = '#dde8ff';
                    ctx.fillText(Hud.fmtTime(lapTime), rowX + rowW - 16 * S, midY - 8 * S);
                    ctx.font = `${Math.round(12 * S)}px monospace`;
                    ctx.fillStyle = 'rgba(255,110,110,0.9)';
                    ctx.fillText(`+${((lapTime - best) / 1000).toFixed(3)}`, rowX + rowW - 16 * S, midY + 9 * S);
                } else {
                    ctx.font = `bold ${Math.round(19 * S)}px monospace`;
                    ctx.fillStyle = '#ffd700';
                    ctx.fillText(Hud.fmtTime(lapTime), rowX + rowW - 16 * S, midY);
                }
            } else {
                ctx.font = `${Math.round(15 * S)}px monospace`;
                ctx.fillStyle = 'rgba(255,120,120,0.9)';
                ctx.fillText('NO TIME', rowX + rowW - 16 * S, midY);
            }
            ctx.restore();
        }

        const remaining = Math.max(0, QUAL_RESULT_MS - phaseTimer);
        if (remaining < 4200) {
            ctx.globalAlpha = 1;
            ctx.textAlign = 'center';
            ctx.fillStyle = '#ff6060';
            ctx.shadowColor = '#ff4444'; ctx.shadowBlur = 20;
            ctx.font = `bold ${Math.round(24 * S)}px Rajdhani, Arial`;
            ctx.fillText(`RACE STARTS IN ${(remaining / 1000).toFixed(1)}s`, cx, listTop + 8 * (rowH + 3 * S) + 34 * S);
            ctx.shadowBlur = 0;
        }
        ctx.restore();
    }

    function _drawCountdown(ctx, W, H) {
        const remaining = Math.max(0, COUNTDOWN_MS - phaseTimer);
        const S = Hud.scale;
        const cx = W / 2, cy = H * 0.22;

        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // Five red lights, F1 style: they light up one per second, then all out.
        const lit = 5 - Math.max(0, Math.ceil((remaining - 200) / 1000));
        const r = 20 * S, gap = 52 * S;
        for (let i = 0; i < 5; i++) {
            const lx = cx - gap * 2 + i * gap;
            const on = i < lit && remaining > 200;
            ctx.beginPath();
            ctx.arc(lx, cy, r, 0, Math.PI * 2);
            ctx.fillStyle = on ? '#ff2b2b' : 'rgba(60,20,20,0.65)';
            ctx.fill();
            ctx.strokeStyle = 'rgba(255,255,255,0.25)';
            ctx.lineWidth = 2;
            ctx.stroke();
            if (on) {
                ctx.globalAlpha = 0.35;
                ctx.beginPath();
                ctx.arc(lx, cy, r * 1.8, 0, Math.PI * 2);
                ctx.fillStyle = '#ff2b2b';
                ctx.fill();
                ctx.globalAlpha = 1;
            }
        }

        if (remaining <= 200) {
            ctx.fillStyle = '#00ff88';
            ctx.shadowColor = '#00ff88'; ctx.shadowBlur = 30;
            ctx.font = `bold ${Math.round(52 * S)}px Rajdhani, Arial`;
            ctx.fillText('GO!', cx, cy + 62 * S);
            ctx.shadowBlur = 0;
        }
        ctx.restore();
    }

    // -------------------------------------------------------------------------
    // Results + call to action
    // -------------------------------------------------------------------------

    /**
     * Results screen, built as a rotating set of full-screen cards.
     *
     * The previous version crammed the classification, the honours and the
     * call to action into three columns sized for a desktop window, which is
     * unreadable on a phone held sideways — the way most of the audience will
     * see it. Each card now owns the whole screen, and every size is expressed
     * in units of screen height so it scales to any aspect ratio.
     */
    const RESULT_CARDS = 4;
    const CARD_MS = 7600;

    function _drawResults(ctx, W, H) {
        const res = preSim.result;
        const u = H / 100;                       // 1 unit = 1% of screen height
        const fade = Math.min(1, phaseTimer / 700);

        const card = Math.floor(phaseTimer / CARD_MS) % RESULT_CARDS;
        const inCard = phaseTimer % CARD_MS;
        const cardFade = Math.min(1, inCard / 350) * Math.min(1, (CARD_MS - inCard) / 350);

        ctx.save();
        ctx.globalAlpha = fade;
        _dim(ctx, W, H, 0.95);

        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // Persistent header
        ctx.fillStyle = 'rgba(255,255,255,0.42)';
        ctx.font = `bold ${2.6 * u}px Rajdhani, Arial`;
        ctx.fillText(`ROUND ${raceNumber}  ·  ${Track.getName().toUpperCase()}  ·  ${res.laps} LAPS  ·  SEED ${res.seedCode}`,
                     W / 2, 5 * u);

        ctx.save();
        ctx.globalAlpha = fade * cardFade;
        if (card === 0)      _cardWinner(ctx, W, H, u, res);
        else if (card === 1) _cardClassification(ctx, W, H, u, res);
        else if (card === 2) _cardHonours(ctx, W, H, u, res);
        else                 _cardVote(ctx, W, H, u, res);
        ctx.restore();

        // Card indicator dots
        for (let i = 0; i < RESULT_CARDS; i++) {
            const dx = W / 2 + (i - (RESULT_CARDS - 1) / 2) * 3.2 * u;
            ctx.beginPath();
            ctx.arc(dx, 96 * u, 0.75 * u, 0, Math.PI * 2);
            ctx.fillStyle = i === card ? '#e94560' : 'rgba(255,255,255,0.22)';
            ctx.fill();
        }

        ctx.fillStyle = 'rgba(255,255,255,0.26)';
        ctx.font = `${2.2 * u}px Rajdhani, Arial`;
        ctx.fillText('N — next race     ·     H — control room', W / 2, 91 * u);

        ctx.restore();
    }

    function _cardWinner(ctx, W, H, u, res) {
        const win = res.standings[0];
        if (!win) return;
        const col = CarSVG.TEAM_COLORS[win.team];

        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.font = `bold ${3.4 * u}px Rajdhani, Arial`;
        ctx.fillText('WINNER', W / 2, 22 * u);

        ctx.shadowColor = col.main;
        ctx.shadowBlur = 5 * u;
        ctx.fillStyle = col.light;
        ctx.font = `bold ${15 * u}px Rajdhani, Arial`;
        ctx.fillText(win.name.toUpperCase(), W / 2, 36 * u);
        ctx.shadowBlur = 0;

        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.font = `${3 * u}px Rajdhani, Arial`;
        const gained = win.placesGained;
        ctx.fillText(`from ${win.gridPosition === 1 ? 'pole position' : 'P' + win.gridPosition + ' on the grid'}` +
                     (gained > 0 ? `  ·  ${gained} place${gained > 1 ? 's' : ''} gained` : ''),
                     W / 2, 47 * u);

        // Runner-up and third, side by side and still large.
        const rest = res.standings.slice(1, 3);
        rest.forEach((s, i) => {
            const c2 = CarSVG.TEAM_COLORS[s.team];
            const x = W / 2 + (i === 0 ? -1 : 1) * W * 0.19;
            ctx.fillStyle = 'rgba(255,255,255,0.35)';
            ctx.font = `bold ${2.8 * u}px Rajdhani, Arial`;
            ctx.fillText(i === 0 ? 'SECOND' : 'THIRD', x, 63 * u);
            ctx.fillStyle = c2.light;
            ctx.font = `bold ${6 * u}px Rajdhani, Arial`;
            ctx.fillText(s.name.toUpperCase(), x, 72 * u);
        });
    }

    function _cardClassification(ctx, W, H, u, res) {
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.font = `bold ${3 * u}px Rajdhani, Arial`;
        ctx.fillText('FINAL CLASSIFICATION', W / 2, 13 * u);

        const rowH = 8.4 * u;
        const top = 20 * u;
        const boxW = Math.min(W * 0.72, 130 * u);
        const x0 = W / 2 - boxW / 2;

        res.standings.forEach((s, i) => {
            const y = top + i * rowH;
            const col = CarSVG.TEAM_COLORS[s.team];

            Hud.rrect(ctx, x0, y, boxW, rowH - 1.1 * u, 0.8 * u);
            ctx.fillStyle = i === 0 ? 'rgba(255,215,0,0.16)'
                          : (i % 2 ? 'rgba(255,255,255,0.045)' : 'rgba(255,255,255,0.085)');
            ctx.fill();
            ctx.fillStyle = col.main;
            ctx.fillRect(x0, y, 0.9 * u, rowH - 1.1 * u);

            const mid = y + (rowH - 1.1 * u) / 2;
            ctx.textAlign = 'left';
            ctx.fillStyle = i === 0 ? '#ffd700' : 'rgba(255,255,255,0.55)';
            ctx.font = `bold ${4 * u}px Rajdhani, Arial`;
            ctx.fillText(`${i + 1}`, x0 + 2.6 * u, mid);

            ctx.fillStyle = s.retired ? 'rgba(255,150,150,0.8)' : '#fff';
            ctx.font = `bold ${4.4 * u}px Rajdhani, Arial`;
            ctx.fillText(s.name, x0 + 9 * u, mid);

            // Grid delta
            ctx.font = `${3.4 * u}px Rajdhani, Arial`;
            const d = s.placesGained;
            if (s.retired) { ctx.fillStyle = '#ff7b7b'; ctx.fillText('DNF', x0 + boxW * 0.52, mid); }
            else if (d !== 0) {
                ctx.fillStyle = d > 0 ? '#5ee08a' : '#ff9b8f';
                ctx.fillText(`${d > 0 ? '▲' : '▼'}${Math.abs(d)}`, x0 + boxW * 0.52, mid);
            }

            ctx.textAlign = 'right';
            ctx.fillStyle = 'rgba(255,255,255,0.55)';
            ctx.font = `${3.2 * u}px Rajdhani, Arial`;
            ctx.fillText(`${s.pitStops} stop${s.pitStops === 1 ? '' : 's'}  ·  ${s.overtakes} passes`,
                         x0 + boxW - 2.6 * u, mid);
            ctx.textAlign = 'center';
        });
    }

    function _cardHonours(ctx, W, H, u, res) {
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.font = `bold ${3 * u}px Rajdhani, Arial`;
        ctx.fillText('RACE HONOURS', W / 2, 13 * u);

        const rows = [];
        if (res.fastestLap)    rows.push(['FASTEST LAP', res.fastestLap.name, Hud.fmtTime(res.fastestLap.time), res.fastestLap.team]);
        if (res.mostOvertakes) rows.push(['MOST OVERTAKES', res.mostOvertakes.name, `${res.mostOvertakes.overtakes} passes`, res.mostOvertakes.team]);
        if (res.mostBoosters)  rows.push(['MOST BOOST PADS', `${res.mostBoosters.team.toUpperCase()} TEAM`, `${res.mostBoosters.count} pads`, res.mostBoosters.team]);
        if (res.cleanestTeam)  rows.push(['CLEANEST RACE', `${res.cleanestTeam.toUpperCase()} TEAM`, 'fewest incidents', res.cleanestTeam]);
        rows.push(['CONDITIONS', res.weather, `finished ${res.weatherEnd}`, 'blue']);
        rows.push(['SAFETY CARS', res.safetyCars ? `${res.safetyCars} deployed` : 'none', res.safetyCars ? '' : 'a clean race', 'yellow']);

        const rowH = 11 * u;
        const top = 22 * u;
        const boxW = Math.min(W * 0.74, 140 * u);
        const x0 = W / 2 - boxW / 2;

        rows.forEach((r, i) => {
            const y = top + i * rowH;
            const col = CarSVG.TEAM_COLORS[r[3]] || CarSVG.TEAM_COLORS.blue;
            Hud.rrect(ctx, x0, y, boxW, rowH - 1.4 * u, 0.8 * u);
            ctx.fillStyle = 'rgba(255,255,255,0.06)';
            ctx.fill();
            ctx.fillStyle = col.main;
            ctx.fillRect(x0, y, 0.9 * u, rowH - 1.4 * u);

            ctx.textAlign = 'left';
            ctx.fillStyle = 'rgba(255,255,255,0.45)';
            ctx.font = `bold ${2.6 * u}px Rajdhani, Arial`;
            ctx.fillText(r[0], x0 + 3 * u, y + 3.2 * u);
            ctx.fillStyle = '#fff';
            ctx.font = `bold ${4.2 * u}px Rajdhani, Arial`;
            ctx.fillText(r[1], x0 + 3 * u, y + 7 * u);
            ctx.textAlign = 'right';
            ctx.fillStyle = 'rgba(255,255,255,0.6)';
            ctx.font = `${3.4 * u}px Rajdhani, Arial`;
            ctx.fillText(r[2], x0 + boxW - 3 * u, y + 6 * u);
            ctx.textAlign = 'center';
        });
    }

    function _cardVote(ctx, W, H, u, res) {
        const pulse = 0.8 + 0.2 * Math.sin(performance.now() * 0.004);
        ctx.fillStyle = `rgba(255,122,144,${pulse})`;
        ctx.font = `bold ${5.6 * u}px Rajdhani, Arial`;
        ctx.fillText('YOU DECIDE THE NEXT RACE', W / 2, 15 * u);

        // Points earned, one big row per team.
        const rowH = 9.5 * u;
        const top = 24 * u;
        const boxW = Math.min(W * 0.72, 130 * u);
        const x0 = W / 2 - boxW / 2;

        Garage.TEAMS.forEach((team, i) => {
            const y = top + i * rowH;
            const col = CarSVG.TEAM_COLORS[team];
            const info = Garage.getTeam(team);
            const gained = awarded && awarded[team] ? awarded[team].total : 0;

            Hud.rrect(ctx, x0, y, boxW, rowH - 1.3 * u, 0.8 * u);
            ctx.fillStyle = `rgba(${_rgb(col.main)},0.20)`;
            ctx.fill();
            ctx.fillStyle = col.main;
            ctx.fillRect(x0, y, 0.9 * u, rowH - 1.3 * u);

            const mid = y + (rowH - 1.3 * u) / 2;
            ctx.textAlign = 'left';
            ctx.fillStyle = col.light;
            ctx.font = `bold ${5 * u}px Rajdhani, Arial`;
            ctx.fillText(team.toUpperCase(), x0 + 3 * u, mid);

            ctx.fillStyle = '#5ee08a';
            ctx.font = `bold ${4.4 * u}px Rajdhani, Arial`;
            ctx.fillText(`+${gained}`, x0 + boxW * 0.30, mid);

            ctx.textAlign = 'right';
            ctx.fillStyle = 'rgba(255,255,255,0.7)';
            ctx.font = `${3.4 * u}px Rajdhani, Arial`;
            ctx.fillText(`${info.bank} to spend`, x0 + boxW - 3 * u, mid);
            ctx.textAlign = 'center';
        });

        // The instruction, big enough to read on a phone.
        ctx.fillStyle = '#ffd97a';
        ctx.font = `bold ${4.6 * u}px Rajdhani, Arial`;
        ctx.fillText('COMMENT A TEAM AND AN UPGRADE', W / 2, 68 * u);
        ctx.fillStyle = '#fff';
        ctx.font = `bold ${5.4 * u}px Rajdhani, Arial`;
        ctx.fillText('"RED BRAKES"   "GREEN TYRES"   "BLUE ENGINE"', W / 2, 76 * u);

        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.font = `${2.9 * u}px Rajdhani, Arial`;
        ctx.fillText(Garage.CATALOG.map(x => x.name).join('  ·  '), W / 2, 83 * u);
    }

    function _rgb(hex) {
        return `${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)}`;
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    function setPaused(v) {
        paused = !!v;
        if (paused) Commentary.cut();
    }
    function isPaused()           { return paused; }
    function setSpeed(mult)       { speedMultiplier = mult; }
    function getSpeedMultiplier() { return speedMultiplier; }
    function getPhase()           { return phase; }
    function getSim()             { return sim; }
    function getPreSim()          { return preSim; }
    function getSeed()            { return seed; }
    function getCars()            { return sim ? sim.cars : []; }
    function getStandings()       { return sim ? (sim.state.order || sim.cars) : []; }
    function getLeader()          { return sim ? sim.state.leader : null; }
    function getTotalLaps()       { return totalLaps; }
    function setTotalLaps(n)      { totalLaps = Math.max(3, Math.min(60, n | 0)); }
    function isFinished()         { return phase === PHASES.RESULTS || phase === PHASES.COOLDOWN; }
    function skipToResults() {
        if (phase === PHASES.RESULTS) return;
        while (sim.phase !== 'finished') {
            if (sim.phase === 'grid') sim.beginRace();
            sim.step();
        }
        eventCursor = preSim.events.length;
        Commentary.cut();
        _to(PHASES.RESULTS);
        _award();
    }

    return {
        init, update, drawWorld, drawScreen, PHASES,
        setPaused, isPaused,
        setSpeed, getSpeedMultiplier, getPhase, getSim, getPreSim, getSeed,
        getCars, getStandings, getLeader, getTotalLaps, setTotalLaps,
        isFinished, skipToResults, getLive,
    };
})();
