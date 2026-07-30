/**
 * Commentary — the radio announcer.
 *
 * Two things make this work, and both come from the race being simulated in
 * full before anything is drawn:
 *
 * 1. **Nothing is ever interrupted.** Every line's spoken length is estimated
 *    and the whole broadcast is *scheduled offline*: the most important moments
 *    claim their slot first, everything else fits in the gaps or is dropped.
 *    At playback time the announcer simply reads the schedule. Cutting himself
 *    off mid-sentence when three things happen at once is impossible.
 *
 * 2. **Lines match what is on screen.** The writer knows whether a pass gets
 *    reversed two seconds later, so it never claims "Red takes the lead" over
 *    footage of Green taking it straight back.
 *
 * Speech uses the browser's built-in Web Speech API: no key, no download, no
 * network. Subtitles are always drawn, so it reads fine muted.
 */
const Commentary = (() => {

    const synth = (typeof window !== 'undefined' && window.speechSynthesis) ? window.speechSynthesis : null;

    let enabled = true;
    let voice = null;
    let voiceRate = 1.12;
    let voicePitch = 0.95;

    /** Scheduled broadcast: [{at, dur, text, type, significance, badge}] by time. */
    let plan = [];
    let cursor = 0;
    let current = null;
    const ticker = [];
    let rng = Rng.create(1);
    let liveProvider = null;
    let fillerAt = 0;

    // Scheduling constants, in ms.
    const GAP_AFTER   = 550;    // breath between lines
    const MAX_DELAY   = 1600;   // how late a line may be pushed to find a slot
    const WORD_MS     = 340;    // spoken length per word at rate 1.0
    const LEAD_MS     = 380;    // fixed overhead per utterance

    // -------------------------------------------------------------------------
    // Voice
    // -------------------------------------------------------------------------

    const VOICE_PREFS = [
        'Google UK English Male', 'Daniel', 'Microsoft Ryan', 'Microsoft George',
        'Arthur', 'Oliver', 'Google UK English Female', 'Microsoft Sonia',
        'Google US English', 'Samantha', 'Alex',
    ];

    function pickVoice() {
        if (!synth) return;
        const voices = synth.getVoices();
        if (!voices.length) return;
        for (const want of VOICE_PREFS) {
            const v = voices.find(v => v.name === want);
            if (v) { voice = v; return; }
        }
        voice = voices.find(v => /^en[-_]GB/i.test(v.lang))
             || voices.find(v => /^en/i.test(v.lang))
             || voices[0];
    }

    function listVoices() {
        return synth ? synth.getVoices().filter(v => /^en/i.test(v.lang)) : [];
    }

    function setVoiceByName(name) {
        if (!synth) return;
        const v = synth.getVoices().find(v => v.name === name);
        if (v) voice = v;
    }

    function init() {
        if (!synth) return;
        pickVoice();
        if (synth.onvoiceschanged !== undefined) {
            synth.addEventListener('voiceschanged', pickVoice);
        }
        // Chrome silently suspends speech synthesis after ~15 s of continuous
        // use. Nudging pause/resume keeps the announcer alive for a whole race.
        if (typeof setInterval === 'function') {
            setInterval(() => {
                if (synth.speaking && !synth.paused) { synth.pause(); synth.resume(); }
            }, 9000);
        }
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    function fmtTime(ms) {
        if (!ms || !Number.isFinite(ms)) return '--';
        const m = Math.floor(ms / 60000);
        const s = ((ms % 60000) / 1000);
        return m > 0 ? `${m}:${s.toFixed(2).padStart(5, '0')}` : `${s.toFixed(2)}`;
    }

    function spokenTime(ms) {
        if (!ms || !Number.isFinite(ms)) return 'no time';
        const total = ms / 1000;
        const m = Math.floor(total / 60);
        const s = (total % 60).toFixed(2);
        return m > 0 ? `${m} minute ${s} seconds` : `${s} seconds`;
    }

    const BADGES = {
        overtake:       { text: 'OVERTAKE',      color: '#ffd23b' },
        lead_change:    { text: 'NEW LEADER',    color: '#ff5c8a' },
        fastest_lap:    { text: 'FASTEST LAP',   color: '#c77dff' },
        pit_enter:      { text: 'PIT STOP',      color: '#7ee0ff' },
        pit_exit:       { text: 'OUT OF THE PITS', color: '#7ee0ff' },
        spin:           { text: 'SPIN!',         color: '#ff7043' },
        crash:          { text: 'CONTACT!',      color: '#ff4444' },
        contact:        { text: 'CONTACT',       color: '#ff6b6b' },
        dnf:            { text: 'RETIREMENT',    color: '#ff4444' },
        sc_deploy:      { text: 'SAFETY CAR',    color: '#ffcc00' },
        sc_end:         { text: 'GREEN FLAG',    color: '#4ade80' },
        weather_change: { text: 'WEATHER',       color: '#66d9ff' },
        final_lap:      { text: 'FINAL LAP',     color: '#ffffff' },
        chequered:      { text: 'CHEQUERED FLAG', color: '#ffffff' },
        mech_issue:     { text: 'TROUBLE',       color: '#ffa726' },
        battle:         { text: 'BATTLE',        color: '#8ef' },
        tyre_critical:  { text: 'TYRES GONE',    color: '#ff9e6b' },
    };

    function pick(arr) { return arr[Math.floor(rng.next() * arr.length)]; }

    /** Sentences assembled from fragments can start lower-case. Fix that. */
    function capitalise(t) {
        return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
    }

    /** Pick from `arr`, avoiding phrasings used in the last few lines. */
    const recent = [];
    function pickFresh(arr) {
        const fresh = arr.filter(t => !recent.includes(t));
        const choice = pick(fresh.length ? fresh : arr);
        recent.push(choice);   // track the raw form so variants stay distinct
        if (recent.length > 18) recent.shift();
        return capitalise(choice);
    }

    function ordinal(p) {
        return ['', 'the lead', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'][p] || `P${p}`;
    }

    // -------------------------------------------------------------------------
    // Line writing
    // -------------------------------------------------------------------------

    /** Turn one event into a spoken line. Deterministic given the seed. */
    function writeLine(e, meta) {
        const d = e.data;
        switch (e.type) {

            case 'lights_out':
                return pickFresh([
                    `Lights out and away we go at ${meta.trackName}! ${d.poleSpeech} leads them away.`,
                    `And they're racing! ${d.laps} laps here at ${meta.trackName}, ${d.poleSpeech} on pole.`,
                    `We are green! ${d.poleSpeech} gets the jump into turn one.`,
                    `Away they go, all eight of them, and ${d.poleSpeech} holds the inside line.`,
                    `The lights go out — ${d.laps} laps to settle this.`,
                ]);

            case 'overtake':
                return _overtakeLine(d);

            case 'lead_change':
                return pickFresh([
                    `We have a new race leader: ${d.speechName}!`,
                    `${d.speechName} is the new leader of this race.`,
                    `${d.speechName} heads this race for the first time.`,
                    `Out in front now, it's ${d.speechName}.`,
                ]);

            case 'fastest_lap':
                return d.finalHolder
                    ? pickFresh([
                        `Fastest lap of the race for ${d.speechName} — ${spokenTime(d.time)}. Nobody beats that.`,
                        `${d.speechName} sets the benchmark: ${spokenTime(d.time)}, and it stands all afternoon.`,
                        `That is the lap of the race, ${spokenTime(d.time)} for ${d.speechName}.`,
                      ])
                    : pickFresh([
                        `Purple sector — fastest lap for ${d.speechName}, ${spokenTime(d.time)}.`,
                        `${d.speechName} goes quickest of all, ${spokenTime(d.time)}.`,
                        `New quickest lap: ${d.speechName}, and there is more in that car.`,
                        `${d.speechName} is finding real pace now — fastest lap so far.`,
                      ]);

            case 'pit_enter':
                if (d.reason === 'weather') return pickFresh([
                    `${d.speechName} dives into the pit lane for the ${d.compound} tyre. Big call.`,
                    `Here comes ${d.speechName} — they're gambling on the ${d.compound}s.`,
                    `${d.speechName} has seen enough of these conditions. Into the pits for ${d.compound}s.`,
                ]);
                if (d.reason === 'repairs') return pickFresh([
                    `${d.speechName} limps into the pits for repairs. That race is in ruins.`,
                    `Unscheduled stop for ${d.speechName}. The damage was too much.`,
                ]);
                if (d.reason === 'undercut') return pickFresh([
                    `${d.speechName} boxes to cover the undercut. Cat and mouse, this.`,
                    `Straight in behind their rival — ${d.speechName} is not letting that undercut work.`,
                ]);
                if (d.reason === 'safety car') return pickFresh([
                    `${d.speechName} takes the free stop under the safety car. Smart.`,
                    `Cheap pit stop for ${d.speechName} while the field is slow.`,
                ]);
                return pickFresh([
                    `${d.speechName} peels into the pit lane from ${ordinal(d.position)}.`,
                    `Pit stop for ${d.speechName}, going onto the ${d.compound}.`,
                    `${d.speechName} has had enough of those tyres — into the pits.`,
                    `And it's ${d.speechName} who blinks first. Box, box.`,
                    `${d.speechName} comes in on lap ${d.lap}. ${d.compound} tyres going on.`,
                ]);

            case 'pit_exit':
                if (d.gainedPlaces > 0) return pickFresh([
                    `Superb stop! ${d.speechName} rejoins having gained ${d.gainedPlaces} place${d.gainedPlaces > 1 ? 's' : ''}.`,
                    `The undercut works! ${d.speechName} comes out ahead in ${ordinal(d.position)}.`,
                    `That is how you do it — ${d.speechName} leaves the pit lane up to ${ordinal(d.position)}.`,
                ]);
                if (d.lostPlaces > 1) return pickFresh([
                    `That has cost them — ${d.speechName} rejoins down in ${ordinal(d.position)}.`,
                    `Slow one there, and ${d.speechName} drops ${d.lostPlaces} places.`,
                    `${d.speechName} loses ground in the pit lane, down to ${ordinal(d.position)}.`,
                ]);
                return pickFresh([
                    `${d.speechName} back out on the ${d.compound}, ${ordinal(d.position)}.`,
                    `${d.speechName} rejoins in ${ordinal(d.position)} with fresh rubber.`,
                    `Clean stop, and ${d.speechName} is on his way again.`,
                ]);

            case 'spin':
                return pickFresh([
                    `${d.speechName} spins! ${d.cause}, and they're facing the wrong way!`,
                    `Round goes ${d.speechName}! That's a huge moment.`,
                    `${d.speechName} loses it — a spin from ${ordinal(d.position)}.`,
                    `Oh! ${d.speechName} has thrown it away, spinning on the exit.`,
                ]);

            case 'crash':
                return pickFresh([
                    `Contact! ${d.speechName} and ${d.otherSpeech} bang wheels!`,
                    `Oh, they've hit each other! ${d.speechName} into ${d.otherSpeech}.`,
                    `That is a big hit between ${d.speechName} and ${d.otherSpeech}!`,
                ]);

            case 'contact':
                return pickFresh([
                    `Wheel to wheel, ${d.speechName} and ${d.otherSpeech} rubbing paint.`,
                    `A touch between ${d.speechName} and ${d.otherSpeech}. No love lost.`,
                    `They are leaning on each other out there, ${d.speechName} and ${d.otherSpeech}.`,
                ]);

            case 'dnf':
                return pickFresh([
                    `And that's the end of the race for ${d.speechName} — ${d.reason}.`,
                    `Heartbreak for ${d.speechName}. ${d.reason} on lap ${d.lap}.`,
                    `${d.speechName} is out. ${d.reason}.`,
                    `That is a retirement. ${d.speechName} parks it with ${d.reason}.`,
                ]);

            case 'mech_issue':
                return pickFresh([
                    `${d.speechName} is ${d.issue}. They're in trouble out there.`,
                    `Problem for ${d.speechName} — ${d.issue}.`,
                    `${d.speechName} has ${d.issue} and the pace has gone.`,
                ]);

            case 'sc_deploy':
                return pickFresh([
                    `Safety car! Safety car deployed on lap ${d.lap}. The field is about to bunch up.`,
                    `The safety car is out, and that throws this race wide open.`,
                    `Yellow flags and the safety car — every gap in this race just vanished.`,
                ]);

            case 'sc_end':
                return pickFresh([
                    `Safety car in this lap — we go green, and it is a sprint from here.`,
                    `Green flag! Racing resumes and the gaps are gone.`,
                    `The safety car peels off. Everyone nose to tail, and it is on.`,
                ]);

            case 'weather_change':
                if (/RAIN/.test(d.to)) return pickFresh([
                    `And it's starting to rain! ${d.to} over the circuit. This changes everything.`,
                    `Here comes the weather — ${d.to}. Everyone's strategy just went out the window.`,
                    `Rain. ${d.to} now, and nobody knows what the right tyre is.`,
                ]);
                if (d.to === 'DRY') return pickFresh([
                    `The track is drying out. Time to think about slicks.`,
                    `A dry line is appearing — the crossover point is coming.`,
                ]);
                return pickFresh([
                    `Conditions changing: ${d.to} out there now.`,
                    `${d.to} across the circuit, and the grip is shifting under them.`,
                ]);

            case 'final_lap':
                return Number.isFinite(d.gap) && d.gap < 1.2
                    ? pickFresh([
                        `Final lap! And it is nowhere near settled — ${d.chaserSpeech} is right on the gearbox of ${d.leaderSpeech}!`,
                        `Last lap, and this is going down to the wire!`,
                        `One lap left and less than a second between the top two. Anything could happen.`,
                      ])
                    : pickFresh([
                        `Final lap. ${d.leaderSpeech} leads them onto the last tour.`,
                        `One lap to go, and ${d.leaderSpeech} is in control.`,
                        `Last lap. ${d.leaderSpeech} just has to bring it home now.`,
                      ]);

            case 'chequered':
                return d.margin < 0.6
                    ? pickFresh([
                        `${d.speechName} wins it! By a nose! What a finish!`,
                        `Photo finish — and it is ${d.speechName} who takes the flag!`,
                      ])
                    : pickFresh([
                        `${d.speechName} takes the chequered flag and wins at ${meta.trackName}!`,
                        `Victory for ${d.speechName}! A brilliant drive.`,
                        `The chequered flag falls, and ${d.speechName} is the winner here.`,
                      ]);

            case 'race_end':
                return pickFresh([
                    `That's the race. ${d.winnerSpeech} wins it. Head to the comments and tell us where the development points should go.`,
                    `Race over. ${d.winnerSpeech} on the top step — now it's your turn: vote for the upgrades in the comments.`,
                ]);

            case 'battle':
                return pickFresh([
                    `A real scrap for ${ordinal(d.position)} — ${d.speechName} all over the back of ${d.aheadSpeech}.`,
                    `${d.speechName} is hunting ${d.aheadSpeech} for ${ordinal(d.position)}. Less than half a second.`,
                    `${d.speechName} will not go away. Glued to ${d.aheadSpeech}.`,
                    `Look at this fight for ${ordinal(d.position)}. Neither of them giving an inch.`,
                ]);

            case 'tyre_critical':
                return pickFresh([
                    `${d.speechName} is running out of tyre. Those ${d.compound}s are done.`,
                    `Look at the pace drop from ${d.speechName} — the rubber has given up.`,
                    `${d.speechName} is on the ragged edge with those tyres now.`,
                ]);

            case 'podium_note':
                return pickFresh([
                    `${d.speechName} completes the podium in ${ordinal(d.position)}.`,
                    `A ${ordinal(d.position)}-place finish for ${d.speechName}.`,
                ]);

            default:
                return null;
        }
    }

    /**
     * Overtakes get their own writer: it is the most common event and the one
     * most likely to be contradicted by what the viewer can see.
     */
    function _overtakeLine(d) {
        const who = d.speechName, victim = d.victimSpeech;
        const place = ordinal(d.position);

        // ── An exchange deep into a long duel ──
        if (d.duelExchange >= 4) {
            return pickFresh([
                `They are trading this place lap after lap — ${who} ahead again.`,
                `Another exchange in this duel, and it's ${who} in front for now.`,
                `This battle just will not settle. ${who} back ahead of ${victim}.`,
                `Round and round they go — ${who} has ${place} once more.`,
            ]);
        }

        // ── Taking a place straight back ──
        if (d.isRetake && d.retakeAfter < 9) {
            return pickFresh([
                `And ${who} takes it straight back! They are not messing about.`,
                `Immediate response — ${who} has ${place} back already.`,
                `${who} returns the favour! Back into ${place}.`,
                `No sooner lost than regained — ${who} is through on ${victim} again.`,
                `They swap places again! ${who} leads that battle for now.`,
                `${who} was never going to accept that. Straight back past ${victim}.`,
                `The counter-attack lands — ${who} reclaims ${place} immediately.`,
            ]);
        }

        // ── A pass we know will not stick ──
        if (d.reversedIn !== undefined && d.reversedIn < 9) {
            return pickFresh([
                `${who} is through on ${victim} — but I don't think that is settled!`,
                `${who} takes ${place}, though ${victim} is going nowhere.`,
                `${who} noses ahead of ${victim}. Hold on, this fight is not over.`,
                `Briefly ${place} for ${who} — ${victim} is already coming back at him.`,
                `${who} gets ahead, but keep watching: ${victim} is not finished.`,
                `${who} into ${place} for the moment, and only for the moment.`,
            ]);
        }

        // ── The move that wins the race ──
        if (d.raceWinningMove) {
            return pickFresh([
                `${who} takes the lead — and that, right there, is the move that wins this race!`,
                `Into the lead goes ${who}! Remember this one — it decides the whole race.`,
                `This is the winning move. ${who} goes by ${victim} and never looks back.`,
            ]);
        }

        // ── For the lead ──
        if (d.position === 1) {
            return pickFresh([
                `${who} takes the lead from ${victim}! Sensational!`,
                `There it is! ${who} is through into first place!`,
                `New leader! ${who} muscles past ${victim}!`,
                `${who} is into the lead, and ${victim} has no answer!`,
                `The lead changes hands — ${who} is in front!`,
            ]);
        }

        // ── Character of the move ──
        if (d.aroundOutside) return pickFresh([
            `${who} goes around the outside of ${victim}! Beautiful move for ${place}.`,
            `Oh, that is brave! ${who} takes ${place} around the outside.`,
            `Around the outside and it sticks — ${who} into ${place}.`,
        ]);
        if (d.underBraking) return pickFresh([
            `${who} dives down the inside under braking! ${place}.`,
            `Late on the brakes and it works — ${who} takes ${place} from ${victim}.`,
            `Brilliant braking from ${who} to claim ${place}.`,
        ]);
        if (d.drs) return pickFresh([
            `${who} has the DRS open and sails past ${victim} for ${place}.`,
            `With DRS, ${who} makes it look easy on ${victim}. ${place}.`,
            `DRS does the job — ${who} breezes into ${place}.`,
        ]);
        if (d.boost) return pickFresh([
            `${who} rockets past ${victim} off the boost pad! ${place}.`,
            `That boost gives ${who} all the run he needs. ${place}.`,
        ]);
        if (d.teammate) return pickFresh([
            `Team-mates side by side — and ${who} comes out ahead for ${place}.`,
            `${who} gets by their own team-mate ${victim}. That will be a tense debrief.`,
            `Team orders going out the window there. ${who} into ${place}.`,
        ]);
        if (d.gripEdge > 0.05) return pickFresh([
            `The fresher rubber tells — ${who} breezes past ${victim} for ${place}.`,
            `No contest on those tyres. ${who} takes ${place}.`,
            `${victim} is a sitting duck on old tyres. ${who} into ${place}.`,
        ]);

        return pickFresh([
            `${who} is through on ${victim} for ${place}!`,
            `Position change! ${who} takes ${place}.`,
            `${victim} has no answer — ${who} moves up to ${place}.`,
            `${who} makes it stick. ${place} for him.`,
            `Well judged from ${who}, up into ${place}.`,
        ]);
    }

    // -------------------------------------------------------------------------
    // Scheduling — the whole broadcast, laid out offline
    // -------------------------------------------------------------------------

    function estimateMs(text) {
        const words = text.split(/\s+/).length;
        return LEAD_MS + (words / voiceRate) * WORD_MS;
    }

    /**
     * @param {Array}  events analysed event log from Sim.runHeadless()
     * @param {object} meta   { trackName, seed, totalLaps, duration }
     */
    function load(events, meta) {
        rng = Rng.create((meta.seed ^ 0x9e3779b9) >>> 0);
        recent.length = 0;

        // 1. Write a line for every candidate, in time order so the
        //    anti-repetition window follows the race.
        const candidates = [];
        for (const e of events) {
            if (!e.speakable) continue;
            const text = writeLine(e, meta);
            if (!text) continue;
            candidates.push({
                t: e.t,
                text,
                dur: estimateMs(text),
                type: e.type,
                significance: e.significance,
                badge: BADGES[e.type] || null,
                data: e.data,
            });
        }

        // 2. Book slots, most important first. A line takes its natural moment
        //    if the airwaves are free, slips up to MAX_DELAY later if not, and
        //    is dropped if even that clashes. Because this happens offline the
        //    announcer is never cut off at playback.
        const booked = [];
        const fits = (start, dur) =>
            !booked.some(b => start < b.at + b.dur + GAP_AFTER && start + dur + GAP_AFTER > b.at);

        for (const c of candidates.slice().sort((a, b) => b.significance - a.significance)) {
            let at = -1;
            if (fits(c.t, c.dur)) at = c.t;
            else {
                // Try the first free moment within the allowed delay.
                for (const b of booked.slice().sort((x, y) => x.at - y.at)) {
                    const after = b.at + b.dur + GAP_AFTER;
                    if (after > c.t + MAX_DELAY) break;
                    if (after >= c.t && fits(after, c.dur)) { at = after; break; }
                }
            }
            if (at < 0) { c.dropped = true; continue; }
            booked.push(Object.assign({}, c, { at }));
        }

        booked.sort((a, b) => a.at - b.at);
        plan = booked;
        reset();
        return plan;
    }

    function reset() {
        cursor = 0;
        current = null;
        ticker.length = 0;
        fillerAt = 18000;
        if (synth) synth.cancel();
    }

    function setLiveProvider(fn) { liveProvider = fn; }

    // -------------------------------------------------------------------------
    // Playback — just read the schedule
    // -------------------------------------------------------------------------

    function speak(text, opts = {}) {
        const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
        current = {
            text,
            badge: opts.badge || null,
            type: opts.type || 'note',
            significance: opts.significance || 40,
            startedAt: now,
            until: now + (opts.dur || estimateMs(text)),
        };
        ticker.unshift({ text, type: current.type, at: now });
        if (ticker.length > 24) ticker.pop();

        if (!enabled || !synth) return;
        try {
            const u = new SpeechSynthesisUtterance(text);
            if (voice) u.voice = voice;
            u.rate = voiceRate;
            u.pitch = voicePitch;
            u.volume = 1;
            synth.speak(u);
        } catch (err) {
            /* speech is a nice-to-have; subtitles carry the broadcast */
        }
    }

    /** Interrupt whatever is being said. Used for phase changes only. */
    function cut() {
        if (synth) synth.cancel();
        current = null;
    }

    /** Push a line straight to the announcer (phase transitions). */
    function say(text, significance = 90) {
        cut();
        speak(text, { significance, type: 'note' });
    }

    /**
     * @param {number} simTimeMs current race time
     * @param {boolean} running  false while paused / between phases
     */
    function update(simTimeMs, running) {
        const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
        if (current && now >= current.until) current = null;
        if (!running) return;

        // Skip anything we somehow ran past (fast-forward, skip to result).
        while (cursor < plan.length && plan[cursor].at < simTimeMs - 4000) cursor++;

        if (!current && cursor < plan.length && plan[cursor].at <= simTimeMs) {
            const item = plan[cursor++];
            speak(item.text, item);
            fillerAt = simTimeMs + 15000 + rng.next() * 9000;
            return;
        }

        if (!current) _maybeFiller(simTimeMs);
    }

    /** When the race goes quiet, give the viewer a status update. */
    function _maybeFiller(simTimeMs) {
        if (!liveProvider || simTimeMs < fillerAt) return;
        // Never talk over a scheduled line that is about to start.
        const next = plan[cursor];
        if (next && next.at - simTimeMs < 6000) return;
        fillerAt = simTimeMs + 15000 + rng.next() * 9000;

        const live = liveProvider();
        if (!live || !live.order || live.order.length < 2) return;

        const p1 = live.order[0], p2 = live.order[1];
        const gap = Number.isFinite(p2.gapAheadSec) ? p2.gapAheadSec : 0;
        const lapsLeft = Math.max(0, live.totalLaps - live.lap);

        const options = [];
        if (gap < 1.0) {
            options.push(`${p1.speechName} leads, but ${p2.speechName} is right there — ${gap.toFixed(1)} seconds.`);
            options.push(`Under a second between the top two with ${lapsLeft} laps to run.`);
        } else {
            options.push(`${p1.speechName} leads by ${gap.toFixed(1)} seconds, ${lapsLeft} laps remaining.`);
            options.push(`${lapsLeft} laps left, and ${p1.speechName} has a ${gap.toFixed(1)} second cushion.`);
        }
        if (live.weatherLabel && live.weatherLabel !== 'DRY') {
            options.push(`Still ${live.weatherLabel.toLowerCase()} out there, and they are struggling for grip.`);
        }
        const mover = live.order.slice().sort((a, b) => b.overtakes - a.overtakes)[0];
        if (mover && mover.overtakes >= 3) {
            options.push(`${mover.speechName} has made ${mover.overtakes} passes so far — the mover of the race.`);
        }
        const worn = live.order.filter(c => c.tyreWear > 0.7 && !c.inPitLane)[0];
        if (worn) options.push(`${worn.speechName} is asking a lot of those tyres now.`);
        const boxing = live.order.filter(c => c.pitState === 'requested')[0];
        if (boxing) options.push(`${boxing.speechName} has been called in. Watch the pit lane.`);

        speak(pickFresh(options), { significance: 25, type: 'gap_note' });
    }

    // -------------------------------------------------------------------------

    function setEnabled(v) {
        enabled = !!v;
        if (!enabled && synth) synth.cancel();
    }
    function isEnabled() { return enabled; }
    function setRate(r)  { voiceRate = Math.max(0.6, Math.min(1.8, r)); }
    function getCurrent(){ return current; }
    function getTicker() { return ticker; }
    function getPlan()   { return plan; }

    return {
        init, load, reset, update, say, cut, setEnabled, isEnabled, setRate,
        getCurrent, getTicker, getPlan, setLiveProvider,
        listVoices, setVoiceByName, fmtTime, estimateMs, BADGES,
    };
})();
