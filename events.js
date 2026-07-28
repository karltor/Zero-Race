/**
 * Race event log.
 *
 * The simulation stamps every interesting moment with the simulation time it
 * happened at. Because the sim is deterministic, running it headless first
 * gives us the *whole story* before a single frame is drawn — which is exactly
 * what a commentator needs: they can say "and that will turn out to be the
 * move that wins him the race" while it is happening.
 *
 * After the headless run, `analyse()` walks the log backwards, gives every
 * event a significance score using that hindsight, and thins out clusters so
 * the announcer never has three things to say in the same half-second.
 */
const EventLog = (() => {

    /** Base importance per event type, before context. Higher = more airtime. */
    const BASE = {
        lights_out:      100,
        race_end:        100,
        chequered:        95,
        final_lap:        88,
        lead_change:      86,
        sc_deploy:        84,
        dnf:              82,
        crash:            74,
        weather_change:   72,
        sc_end:           70,
        overtake:         60,
        fastest_lap:      58,
        pit_enter:        44,
        pit_exit:         46,
        spin:             56,
        mech_issue:       52,
        tyre_critical:    40,
        battle:           38,
        drs_armed:        26,
        boost:            22,
        oil_hit:          30,
        contact:          28,
        lap:              18,
        gap_note:         16,
        podium_note:      34,
    };

    function create() {
        const events = [];
        let seq = 0;

        return {
            events,
            /**
             * @param {number} t   simulation time in ms
             * @param {string} type
             * @param {object} data plain, serialisable payload
             */
            add(t, type, data = {}) {
                events.push({
                    t,
                    seq: seq++,          // tie-break for identical timestamps: emission order
                    type,
                    base: BASE[type] !== undefined ? BASE[type] : 20,
                    significance: BASE[type] !== undefined ? BASE[type] : 20,
                    data,
                });
            },
            get length() { return events.length; },
        };
    }

    /**
     * Score every event with hindsight and mark the ones worth speaking.
     *
     * @param {object} log     from create()
     * @param {object} result  final race result from Sim.getResult()
     * @param {object} meta    { raceDuration, totalLaps }
     */
    function analyse(log, result, meta) {
        const evts = log.events;
        const finalPos = {};                 // carId → finishing position (1-based)
        result.standings.forEach((s, i) => { finalPos[s.id] = i + 1; });
        const winnerId = result.standings[0] ? result.standings[0].id : null;
        const duration = Math.max(1, meta.raceDuration || 1);

        for (const e of evts) {
            let s = e.base;
            const d = e.data;

            // Late drama is worth more than early drama.
            const lateness = Math.min(1, e.t / duration);
            s += lateness * 14;

            switch (e.type) {
                case 'overtake': {
                    // Position fought over matters most.
                    const p = d.position || 8;
                    s += Math.max(0, (9 - p)) * 5.5;
                    if (p === 1) s += 26;
                    if (d.drs) s += 4;
                    if (d.aroundOutside) s += 9;
                    if (d.underBraking) s += 5;
                    // Hindsight: did the move stick to the flag?
                    if (finalPos[d.carId] && finalPos[d.victimId] &&
                        finalPos[d.carId] < finalPos[d.victimId]) {
                        s += 8;
                        d.stuck = true;
                    }
                    // Hindsight: was this the move that decided the win?
                    if (d.position === 1 && d.carId === winnerId && e.t > duration * 0.55) {
                        s += 22;
                        d.raceWinningMove = true;
                    }
                    break;
                }
                case 'lead_change':
                    if (d.carId === winnerId) s += 10;
                    break;
                case 'fastest_lap':
                    // Only the final holder of the fastest lap is really newsworthy.
                    if (result.fastestLap && d.carId === result.fastestLap.id) { s += 12; d.finalHolder = true; }
                    break;
                case 'pit_enter':
                    if (d.position <= 3) s += 12;
                    if (d.unscheduled) s += 14;
                    break;
                case 'pit_exit':
                    if (d.gainedPlaces > 0) { s += 8 + d.gainedPlaces * 4; }
                    if (d.lostPlaces > 0) s += 4 + d.lostPlaces * 3;
                    if (d.position <= 3) s += 10;
                    break;
                case 'dnf':
                    if (d.position <= 3) s += 16;
                    break;
                case 'crash':
                case 'spin':
                    s += Math.min(20, (d.severity || 0) * 20);
                    if (d.position <= 3) s += 10;
                    break;
                case 'battle':
                    s += Math.max(0, (9 - (d.position || 8))) * 3;
                    break;
            }

            e.significance = s;
        }

        // ── Thin out clusters ─────────────────────────────────────────────
        // Sort by time, then walk a sliding window: inside a 2.6 s window keep
        // at most the two most significant events, and never two of the same
        // type. Everything else is still in the log (the ticker shows it) but
        // is marked `speakable = false`.
        evts.sort((a, b) => a.t - b.t || a.seq - b.seq);

        const WINDOW = 2600;
        for (const e of evts) e.speakable = true;

        for (let i = 0; i < evts.length; i++) {
            const e = evts[i];
            if (!e.speakable) continue;
            for (let j = i + 1; j < evts.length && evts[j].t - e.t < WINDOW; j++) {
                const o = evts[j];
                if (!o.speakable) continue;
                // A clearly bigger story steals the microphone.
                if (o.significance > e.significance + 6) { e.speakable = false; break; }
                else o.speakable = false;
            }
        }

        // Always keep the structural beats, whatever else is going on.
        const ALWAYS = new Set(['lights_out', 'race_end', 'chequered', 'final_lap', 'sc_deploy', 'sc_end', 'weather_change']);
        for (const e of evts) if (ALWAYS.has(e.type)) e.speakable = true;

        return evts;
    }

    return { create, analyse, BASE };
})();
