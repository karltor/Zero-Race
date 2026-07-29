/**
 * Sim — the deterministic race simulation.
 *
 * This is the heart of the whole project. `Sim.create(seed)` builds a complete
 * race from a seed; stepping it with a fixed timestep always produces exactly
 * the same result. That lets us:
 *
 *   1. run the entire race headless in a few hundred milliseconds,
 *   2. keep the full timestamped event log that comes out of it,
 *   3. re-run the same seed in real time and know, at every moment, what is
 *      about to happen — which is what the commentator needs to hype a move
 *      *while* it is happening.
 *
 * Nothing in here touches the DOM or the canvas.
 */
const Sim = (() => {

    const TEAMS = ['blue', 'yellow', 'red', 'green'];
    const TEAM_NUMBERS = { blue: [1, 2], yellow: [3, 4], red: [5, 6], green: [7, 8] };
    const FIXED_DT = 1 / 60;                 // seconds — never varies
    const MAX_SIM_MS = 16 * 60 * 1000;       // hard safety stop for headless runs

    const SC_SPEED = 150;
    const SC_LAPS = 1.6;

    function create(seed, options = {}) {
        const opts = Object.assign({
            totalLaps: 10,
            mods: null,           // { team: modifiers } — defaults to the saved garage
            effects: true,        // false for headless runs
            qualifying: true,
        }, options);

        const rootRng = Rng.create(seed);
        const carRng   = rootRng.fork();
        const raceRng  = rootRng.fork();
        const powerRng = rootRng.fork();
        const weatherRng = rootRng.fork();

        const events = EventLog.create();
        const mods = opts.mods || (typeof Garage !== 'undefined' ? Garage.snapshotModifiers() : {});

        // Rough race length used to place the weather forecast.
        const estLapMs = Math.max(6000, Track.getTrackLength() / 250 * 1000);
        const weather = Weather.create(weatherRng, estLapMs * opts.totalLaps);
        const powerUps = PowerUps.create(powerRng);

        const cars = [];
        for (const team of TEAMS) {
            for (const num of TEAM_NUMBERS[team]) {
                cars.push(new Car(team, num, { rng: carRng, mods: mods[team] }));
            }
        }

        const state = {
            seed,
            phase: 'qual',        // qual | grid | race | finished
            simTime: 0,           // ms of simulated time in the current phase
            raceTime: 0,          // ms since lights out
            totalLaps: opts.totalLaps,
            cars,
            leader: null,
            finishOrder: [],
            qualifyingResults: [],
            fastestLap: null,     // {car, time}
            safetyCar: { active: false, phase: 'none', speed: SC_SPEED, endProgress: 0, timer: 0, count: 0 },
            weather,
            events,
            flag: 'green',        // green | yellow | sc | chequered
            lapOfLeader: 0,
            finished: false,
        };

        // ── internal bookkeeping ────────────────────────────────────────────
        let _prevIdx = {};
        const _passCooldown = {};
        let _battleTimer = 0;
        const _battleSeen = {};
        let _finalLapCalled = false;
        let _lightsOutCalled = false;
        let _lastLeadChange = -99999;

        // ---------------------------------------------------------------------
        // Setup
        // ---------------------------------------------------------------------

        function _startQualifying() {
            // Spread the field evenly around the lap: no traffic, no contact,
            // one warm-up lap and one timed lap each.
            cars.forEach((car, i) => {
                car.reset();
                car.fitTyre('soft');
                car.placeOnTrack(i / cars.length, (i % 2 === 0 ? -1 : 1) * 14);
                car.speed = 120;
                car._qualPhase = 0;
                car._qualLapStart = 0;
                car.qualifyingTime = null;
                car.qualifyingDone = false;
            });
            state.phase = 'qual';
            state.simTime = 0;
        }

        function _finaliseQualifying() {
            const results = cars.map(c => ({ car: c, lapTime: c.qualifyingTime }));
            results.sort((a, b) => (a.lapTime || Infinity) - (b.lapTime || Infinity));
            results.forEach((r, i) => { r.car.position = i + 1; r.car.gridPosition = i + 1; });
            state.qualifyingResults = results;
            state.phase = 'grid';
            _setupGrid();
        }

        function _setupGrid() {
            const startCompound = weather.state.wetness > 0.6 ? 'wet'
                                : weather.state.wetness > 0.25 ? 'inter' : null;
            state.qualifyingResults.forEach((r, i) => {
                const car = r.car;
                const gridPos = i + 1;
                car.reset();
                car.gridPosition = gridPos;
                car.position = gridPos;
                // Everyone works out a full race plan on the grid; the opening
                // compound comes from that plan unless the track is wet.
                const plan = car.planStrategy({ totalLaps: state.totalLaps, weather });
                car.fitTyre(startCompound || plan.compounds[0] || 'medium');
                const side = i % 2 === 0 ? -1 : 1;
                car.placeOnTrack(Track.wrap(-0.008 - i * 0.017), side * 20);
                car.lap = -1;   // the standing-start line crossing must not count as a lap
                car.totalProgress = car.lap + car.progress;
                car._prevPos = gridPos;
            });
            powerUps.init();
            state.finishOrder = [];
            state.order = state.qualifyingResults.map(r => r.car);
            state.leader = state.qualifyingResults[0] ? state.qualifyingResults[0].car : cars[0];
            _prevIdx = {};
            cars.forEach(c => { _prevIdx[c.id] = c.gridPosition - 1; });
        }

        /** Presentation layer calls this when the countdown finishes. */
        function beginRace() {
            if (state.phase !== 'grid') return;
            state.phase = 'race';
            state.simTime = 0;
            state.raceTime = 0;
        }

        // ---------------------------------------------------------------------
        // Stepping
        // ---------------------------------------------------------------------

        function _ctx(noCollisions) {
            return {
                cars,
                simTime: state.simTime,
                timeSinceStart: state.simTime,
                phase: state.phase,
                weather,
                safetyCar: state.safetyCar,
                events,
                rng: raceRng,
                leader: state.leader,
                noCollisions: !!noCollisions,
                totalLaps: state.totalLaps,
                effects: opts.effects,
            };
        }

        /** Advance exactly one fixed tick. */
        function step() {
            const dt = FIXED_DT;
            const dtMs = dt * 1000;

            if (state.phase === 'qual')  { _stepQual(dt, dtMs);  return; }
            if (state.phase === 'race')  { _stepRace(dt, dtMs);  return; }
        }

        function _stepQual(dt, dtMs) {
            state.simTime += dtMs;
            const ctx = _ctx(true);
            weather.step(dt, null, state.simTime);

            for (const car of cars) {
                if (car.qualifyingDone) continue;
                car.update(dt, ctx);

                const covered = car.totalProgress - car._startProgress;
                if (car._qualPhase === 0 && covered >= 1) {
                    car._qualPhase = 1;
                    car._qualLapStart = state.simTime;
                } else if (car._qualPhase === 1 && covered >= 2) {
                    car._qualPhase = 2;
                    car.qualifyingTime = state.simTime - car._qualLapStart;
                    car.qualifyingDone = true;
                }
            }

            // Rank by lap time once set, otherwise by how far round they are.
            const ranked = cars.slice().sort((a, b) => {
                if (a.qualifyingTime && b.qualifyingTime) return a.qualifyingTime - b.qualifyingTime;
                if (a.qualifyingTime) return -1;
                if (b.qualifyingTime) return 1;
                return b.totalProgress - a.totalProgress;
            });
            ranked.forEach((c, i) => { c.position = i + 1; });
            state.order = ranked;
            state.leader = ranked[0] || cars[0];

            if (cars.every(c => c.qualifyingDone) || state.simTime > 180000) {
                for (const c of cars) if (!c.qualifyingDone) c.qualifyingTime = null;
                _finaliseQualifying();
            }
        }

        function _stepRace(dt, dtMs) {
            state.simTime += dtMs;
            state.raceTime = state.simTime;

            if (!_lightsOutCalled) {
                _lightsOutCalled = true;
                events.add(0, 'lights_out', {
                    poleId: state.leader ? state.leader.id : null,
                    poleName: state.leader ? state.leader.name : '',
                    poleSpeech: state.leader ? state.leader.speechName : '',
                    weather: weather.state.label,
                    laps: state.totalLaps,
                });
            }

            const ctx = _ctx(false);
            weather.step(dt, events, state.simTime);
            _updateSafetyCar(dt, ctx);

            for (const car of cars) car.update(dt, ctx);

            _updateOrder(ctx);
            _detectPasses(ctx);
            _checkLapEvents(ctx);
            _checkBattles(dt, ctx);

            powerUps.update(dt, Object.assign(ctx, { leader: state.leader }));

            _checkFinish(ctx);
        }

        // ---------------------------------------------------------------------
        // Order, gaps, DRS reference
        // ---------------------------------------------------------------------

        function _updateOrder(ctx) {
            const running = cars.filter(c => !c.retired);
            const retired = cars.filter(c => c.retired);

            // Finishers keep the order they took the flag in; everyone else is
            // ranked by distance covered; retirements go to the back.
            running.sort((a, b) => {
                const af = state.finishOrder.indexOf(a), bf = state.finishOrder.indexOf(b);
                if (af >= 0 || bf >= 0) {
                    if (af >= 0 && bf >= 0) return af - bf;
                    return af >= 0 ? -1 : 1;
                }
                return b.totalProgress - a.totalProgress;
            });
            retired.sort((a, b) => b.totalProgress - a.totalProgress);

            const ordered = running.concat(retired);
            const trackLen = Track.getTrackLength();
            ordered.forEach((c, i) => {
                c.position = i + 1;
                const ahead = i > 0 ? ordered[i - 1] : null;
                c.ahead = ahead;
                if (ahead && !ahead.retired && !c.retired) {
                    c.gapAheadPx = Math.max(0, (ahead.totalProgress - c.totalProgress) * trackLen);
                    c.gapAheadSec = c.gapAheadPx / Math.max(70, c.speed);
                } else {
                    c.gapAheadPx = Infinity;
                    c.gapAheadSec = Infinity;
                }
            });

            state.order = ordered;
            const newLeader = ordered[0];
            const leadMargin = newLeader && state.leader
                ? (newLeader.totalProgress - state.leader.totalProgress) * trackLen : 0;
            if (newLeader && state.leader && newLeader !== state.leader &&
                state.phase === 'race' && leadMargin > 20 &&
                state.simTime - _lastLeadChange > 3000 &&
                !newLeader.retired && !newLeader.inPitLane &&
                !state.leader.retired && !state.leader.inPitLane) {
                _lastLeadChange = state.simTime;
                events.add(state.simTime, 'lead_change', {
                    carId: newLeader.id, name: newLeader.name, speechName: newLeader.speechName,
                    team: newLeader.team, prevId: state.leader.id, prevName: state.leader.name,
                    prevSpeech: state.leader.speechName, lap: newLeader.lap + 1,
                });
            }
            state.leader = newLeader || state.leader;
            state.lapOfLeader = state.leader ? Math.max(1, Math.min(state.totalLaps, state.leader.lap + 1)) : 1;
        }

        // ---------------------------------------------------------------------
        // Overtake detection — genuine position swaps, not position noise
        // ---------------------------------------------------------------------

        function _detectPasses(ctx) {
            const ordered = state.order;
            const newIdx = {};
            ordered.forEach((c, i) => { newIdx[c.id] = i; });

            for (const c of cars) {
                const prev = _prevIdx[c.id];
                const now = newIdx[c.id];
                if (prev === undefined || now >= prev) continue;
                if (c.retired || c.inPitLane) continue;

                for (const o of cars) {
                    if (o === c || o.retired || o.inPitLane) continue;
                    if (!(_prevIdx[o.id] < prev && newIdx[o.id] > now)) continue;

                    const key = c.id < o.id ? `${c.id}|${o.id}` : `${o.id}|${c.id}`;
                    const last = _passCooldown[key];
                    if (last !== undefined && state.simTime - last < 2000) continue;
                    _passCooldown[key] = state.simTime;

                    const dx = o.x - c.x, dy = o.y - c.y;
                    if (dx * dx + dy * dy > 320 * 320) continue;   // not a wheel-to-wheel move

                    c.overtakes++;
                    o.overtaken++;

                    const curv = Track.curvatureAt(c.trackIndex);
                    const inCorner = curv > 0.028;
                    const outside = inCorner && c.cornerDir &&
                                    Math.sign(c.lateralOffset || 0) === Math.sign(c.cornerDir) &&
                                    Math.abs(c.lateralOffset || 0) > Track.getWidth() * 0.14;

                    events.add(state.simTime, 'overtake', {
                        carId: c.id, name: c.name, speechName: c.speechName, team: c.team,
                        victimId: o.id, victimName: o.name, victimSpeech: o.speechName, victimTeam: o.team,
                        position: now + 1, lap: c.lap + 1,
                        drs: !!c.drsActive,
                        boost: c.boostTimer > 0,
                        underBraking: !!c.braking && inCorner,
                        aroundOutside: !!outside,
                        inCorner,
                        teammate: c.team === o.team,
                        gripEdge: +(c.grip(weather) - o.grip(weather)).toFixed(3),
                    });
                }
            }
            _prevIdx = newIdx;
        }

        // ---------------------------------------------------------------------
        // Lap-triggered checks: fastest lap, mechanical failures, final lap
        // ---------------------------------------------------------------------

        function _checkLapEvents(ctx) {
            for (const car of cars) {
                if (!car._crossedLine) continue;
                car._crossedLine = false;

                // Fastest lap of the race so far
                if (car._newPersonalBest) {
                    car._newPersonalBest = false;
                    if (!state.fastestLap || car.bestLapTime < state.fastestLap.time) {
                        state.fastestLap = { car, time: car.bestLapTime };
                        events.add(state.simTime, 'fastest_lap', {
                            carId: car.id, name: car.name, speechName: car.speechName, team: car.team,
                            time: car.bestLapTime, position: car.position, lap: car.lap,
                        });
                    }
                }

                // Mechanical reliability roll, once per completed lap
                if (car.lap >= 1 && !car.retired && !car._mechDone) {
                    const base = 0.0085 * (1 + car.mods.failure) * (1 + car.damage * 1.6);
                    if (raceRng.chance(Math.max(0, base))) {
                        car._mechDone = true;
                        if (raceRng.chance(0.42)) {
                            car.retire(raceRng.pick(['engine failure', 'gearbox failure', 'hydraulics', 'a puncture']), ctx);
                        } else {
                            car.mechFactor = 0.86;
                            events.add(state.simTime, 'mech_issue', {
                                carId: car.id, name: car.name, speechName: car.speechName, team: car.team,
                                position: car.position, issue: raceRng.pick(['losing power', 'an engine problem', 'a sensor problem']),
                            });
                        }
                    }
                }

                // Tyres past their best — worth a mention before the stop
                if (car.tyreWear > 0.78 && !car._tyreWarned && car.pitState === 'none') {
                    car._tyreWarned = true;
                    events.add(state.simTime, 'tyre_critical', {
                        carId: car.id, name: car.name, speechName: car.speechName, team: car.team,
                        position: car.position, compound: car.tyre.name, wear: car.tyreWear,
                    });
                }
                if (car.tyreWear < 0.3) car._tyreWarned = false;
            }

            if (!_finalLapCalled && state.leader && state.leader.lap >= state.totalLaps - 1) {
                _finalLapCalled = true;
                events.add(state.simTime, 'final_lap', {
                    leaderId: state.leader.id, leaderName: state.leader.name,
                    leaderSpeech: state.leader.speechName,
                    gap: state.order[1] ? state.order[1].gapAheadSec : Infinity,
                    chaserName: state.order[1] ? state.order[1].name : '',
                    chaserSpeech: state.order[1] ? state.order[1].speechName : '',
                });
            }
        }

        /** Sustained close-quarters running is a story even without a pass. */
        function _checkBattles(dt, ctx) {
            _battleTimer -= dt;
            if (_battleTimer > 0) return;
            _battleTimer = 3.0;

            const ordered = state.order || [];
            for (let i = 1; i < ordered.length; i++) {
                const c = ordered[i], a = ordered[i - 1];
                if (!a || c.retired || a.retired || c.inPitLane || a.inPitLane) continue;
                if (c.gapAheadSec > 0.55) { c._battleFor = 0; continue; }
                c._battleFor = (c._battleFor || 0) + 3.0;
                const key = `${a.id}|${c.id}`;
                if (c._battleFor >= 6 && !_battleSeen[key]) {
                    _battleSeen[key] = true;
                    events.add(state.simTime, 'battle', {
                        carId: c.id, name: c.name, speechName: c.speechName, team: c.team,
                        aheadId: a.id, aheadName: a.name, aheadSpeech: a.speechName,
                        position: a.position, gap: c.gapAheadSec,
                    });
                }
            }
        }

        // ---------------------------------------------------------------------
        // Safety car
        // ---------------------------------------------------------------------

        function _updateSafetyCar(dt, ctx) {
            const sc = state.safetyCar;

            if (sc.active) {
                if (sc.phase === 'running' && state.leader && state.leader.totalProgress >= sc.endProgress) {
                    sc.phase = 'ending';
                    sc.timer = 3.0;
                    events.add(state.simTime, 'sc_end', { lap: state.lapOfLeader });
                }
                if (sc.phase === 'ending') {
                    sc.timer -= dt;
                    if (sc.timer <= 0) { sc.active = false; sc.phase = 'none'; state.flag = 'green'; }
                }
                return;
            }

            // Deployment triggers: a big shunt, or several cars in trouble at once.
            if (sc.count >= 2) return;
            if (state.leader && state.leader.lap >= state.totalLaps - 2) return;   // never ruin the finish
            if (state.simTime < 8000) return;

            let severity = 0;
            for (const car of cars) {
                // Only count the first moments of a spin, not every frame of it.
                if (car.spinTimer > 1.1) severity += 0.5;
                if (car.retired && state.simTime - (car._retireTime || 0) < 2500) severity += 0.8;
                if (car.damage > 0.85) severity += 0.3;
            }
            if (severity < 0.45) return;
            if (!raceRng.chance(Math.min(0.5, severity * dt * 0.60))) return;

            sc.active = true;
            sc.phase = 'running';
            sc.count++;
            sc.endProgress = (state.leader ? state.leader.totalProgress : 0) + SC_LAPS;
            state.flag = 'sc';
            events.add(state.simTime, 'sc_deploy', {
                lap: state.lapOfLeader,
                leaderName: state.leader ? state.leader.name : '',
                leaderSpeech: state.leader ? state.leader.speechName : '',
            });
        }

        // ---------------------------------------------------------------------
        // Finish
        // ---------------------------------------------------------------------

        function _checkFinish(ctx) {
            for (const car of cars) {
                if (car.retired || car._finishedRace) continue;
                if (car.lap < state.totalLaps) continue;

                car._finishedRace = true;
                car.finishTime = state.simTime;
                car.finishLap = car.lap;
                car._finishFadeDelay = 2200;
                state.finishOrder.push(car);

                if (state.finishOrder.length === 1) {
                    events.add(state.simTime, 'chequered', {
                        carId: car.id, name: car.name, speechName: car.speechName, team: car.team,
                        margin: state.order[1] ? state.order[1].gapAheadSec : 0,
                        laps: state.totalLaps,
                    });
                } else if (state.finishOrder.length <= 3) {
                    events.add(state.simTime, 'podium_note', {
                        carId: car.id, name: car.name, speechName: car.speechName, team: car.team,
                        position: state.finishOrder.length,
                    });
                }
            }

            const done = cars.every(c => c.retired || c._finishedRace);
            if (done && !state.finished) {
                state.finished = true;
                state.phase = 'finished';
                state.flag = 'chequered';
                events.add(state.simTime, 'race_end', {
                    winnerId: state.finishOrder[0] ? state.finishOrder[0].id : null,
                    winnerName: state.finishOrder[0] ? state.finishOrder[0].name : '',
                    winnerSpeech: state.finishOrder[0] ? state.finishOrder[0].speechName : '',
                });
            }
            if (state.simTime > MAX_SIM_MS && !state.finished) {
                state.finished = true;
                state.phase = 'finished';
            }
        }

        // ---------------------------------------------------------------------
        // Result
        // ---------------------------------------------------------------------

        function getResult() {
            const finishers = state.finishOrder.slice();
            const rest = cars.filter(c => !finishers.includes(c))
                             .sort((a, b) => (a.retired === b.retired ? b.totalProgress - a.totalProgress : (a.retired ? 1 : -1)));
            const standings = finishers.concat(rest).map((c, i) => ({
                id: c.id, name: c.name, speechName: c.speechName, team: c.team, number: c.number,
                position: i + 1, gridPosition: c.gridPosition,
                laps: Math.max(0, c.finishLap !== undefined ? c.finishLap : c.lap), retired: c.retired, dnfReason: c.dnfReason,
                bestLap: c.bestLapTime, overtakes: c.overtakes, pitStops: c.pitStops,
                boosters: c.boostersCollected, contacts: c.contacts, spins: c.spins,
                finishTime: c.finishTime,
                placesGained: (c.gridPosition || 0) - (i + 1),
            }));

            const flCar = cars.filter(c => c.bestLapTime < Infinity)
                              .sort((a, b) => a.bestLapTime - b.bestLapTime)[0];
            const topPasser = cars.slice().sort((a, b) => b.overtakes - a.overtakes)[0];

            const boostersByTeam = {}, overtakesByTeam = {}, contactsByTeam = {};
            for (const t of TEAMS) { boostersByTeam[t] = 0; overtakesByTeam[t] = 0; contactsByTeam[t] = 0; }
            for (const c of cars) {
                boostersByTeam[c.team]  += c.boostersCollected;
                overtakesByTeam[c.team] += c.overtakes;
                contactsByTeam[c.team]  += c.contacts + c.spins;
            }
            const topBoostTeam = Object.entries(boostersByTeam).sort((a, b) => b[1] - a[1])[0];
            const cleanest = Object.entries(contactsByTeam).sort((a, b) => a[1] - b[1])[0];

            return {
                seed,
                seedCode: Rng.toCode(seed),
                trackName: Track.getName(),
                laps: state.totalLaps,
                duration: state.simTime,
                weather: weather.state.headline,
                weatherEnd: weather.state.label,
                standings,
                fastestLap: flCar ? { id: flCar.id, name: flCar.name, speechName: flCar.speechName, team: flCar.team, time: flCar.bestLapTime } : null,
                mostOvertakes: topPasser ? { id: topPasser.id, name: topPasser.name, speechName: topPasser.speechName, team: topPasser.team, overtakes: topPasser.overtakes } : null,
                mostBoosters: topBoostTeam ? { team: topBoostTeam[0], count: topBoostTeam[1] } : null,
                cleanestTeam: cleanest ? cleanest[0] : null,
                overtakesByTeam,
                safetyCars: state.safetyCar.count,
                qualifying: state.qualifyingResults.map((r, i) => ({
                    position: i + 1, id: r.car.id, name: r.car.name, team: r.car.team, time: r.lapTime,
                })),
            };
        }

        // ---------------------------------------------------------------------

        _startQualifying();

        return {
            state, events, weather, powerUps, cars,
            step, beginRace, getResult,
            get phase() { return state.phase; },
            get finished() { return state.finished; },
            FIXED_DT,
        };
    }

    /**
     * Run a whole race with no rendering and return everything we learned.
     * Typically 200–600 ms for a 14-lap race.
     */
    function runHeadless(seed, options = {}) {
        const sim = create(seed, Object.assign({}, options, { effects: false }));
        const t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();

        let guard = 0;
        const MAX_STEPS = 60 * 60 * 20;   // 20 minutes of simulated time
        while (!sim.finished && guard++ < MAX_STEPS) {
            if (sim.phase === 'grid') sim.beginRace();
            sim.step();
        }

        const result = sim.getResult();
        const log = EventLog.analyse(sim.events, result, {
            raceDuration: sim.state.simTime,
            totalLaps: sim.state.totalLaps,
        });
        const t1 = (typeof performance !== 'undefined') ? performance.now() : Date.now();

        return {
            result,
            events: log,
            qualifying: sim.state.qualifyingResults.map((r, i) => ({
                position: i + 1, id: r.car.id, name: r.car.name, speechName: r.car.speechName,
                team: r.car.team, number: r.car.number, time: r.lapTime,
            })),
            weather: sim.weather.state.headline,
            elapsedMs: t1 - t0,
            steps: guard,
        };
    }

    return { create, runHeadless, TEAMS, TEAM_NUMBERS, FIXED_DT };
})();
