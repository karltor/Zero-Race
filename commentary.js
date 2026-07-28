/**
 * Commentary — the radio announcer.
 *
 * Fed by the pre-simulated event log, so every line is written *before* the
 * race is shown. That means the commentator can lean on hindsight ("and that
 * is the move that wins him the race") while the move is still happening.
 *
 * Speech uses the browser's built-in Web Speech API: no API key, no download,
 * no network. Subtitles are always drawn, so the broadcast still reads
 * perfectly with the sound off.
 */
const Commentary = (() => {

    const synth = (typeof window !== 'undefined' && window.speechSynthesis) ? window.speechSynthesis : null;

    let enabled = true;
    let voice = null;
    let voiceRate = 1.12;
    let voicePitch = 0.95;

    let plan = [];          // [{t, text, significance, type, badge}] sorted by t
    let cursor = 0;
    let current = null;     // {text, badge, type, until, started}
    let queue = [];
    const ticker = [];      // recent lines for the on-screen feed
    let lastSpokeAt = -99999;
    let rng = Rng.create(1);
    let liveProvider = null;
    let nextFillerAt = 14000;

    // -------------------------------------------------------------------------
    // Voice
    // -------------------------------------------------------------------------

    /** Prefer a British-sounding male voice — it is what a race feed sounds like. */
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
    // Line writing
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

    /** Short all-caps caption drawn over the action. */
    const BADGES = {
        overtake:       { text: 'OVERTAKE',      color: '#ffd23b' },
        lead_change:    { text: 'NEW LEADER',    color: '#ff5c8a' },
        fastest_lap:    { text: 'FASTEST LAP',   color: '#c77dff' },
        pit_enter:      { text: 'PIT STOP',      color: '#7ee0ff' },
        pit_exit:       { text: 'OUT OF THE PITS', color: '#7ee0ff' },
        spin:           { text: 'SPIN!',         color: '#ff7043' },
        crash:          { text: 'CONTACT!',      color: '#ff4444' },
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

    /** Turn one event into a spoken line. Deterministic given the seed. */
    function writeLine(e, meta) {
        const d = e.data;
        switch (e.type) {

            case 'lights_out':
                return pick([
                    `Lights out and away we go at ${meta.trackName}! ${d.poleSpeech} leads them away.`,
                    `And they're racing! ${d.laps} laps here at ${meta.trackName}, ${d.poleSpeech} on pole.`,
                    `We are green! ${d.poleSpeech} gets the jump into turn one.`,
                ]);

            case 'overtake': {
                if (d.raceWinningMove) return pick([
                    `${d.speechName} takes the lead — and that, right there, is the move that wins this race!`,
                    `Into the lead goes ${d.speechName}! Remember this one — it decides the whole race.`,
                ]);
                if (d.position === 1) return pick([
                    `${d.speechName} takes the lead from ${d.victimSpeech}! Sensational!`,
                    `There it is! ${d.speechName} is through into first place!`,
                    `New leader! ${d.speechName} muscles past ${d.victimSpeech}!`,
                ]);
                if (d.aroundOutside) return pick([
                    `${d.speechName} goes around the outside of ${d.victimSpeech}! Beautiful move for P${d.position}.`,
                    `Oh, that is brave! ${d.speechName} takes P${d.position} around the outside.`,
                ]);
                if (d.drs) return pick([
                    `${d.speechName} has the DRS open and sails past ${d.victimSpeech} for P${d.position}.`,
                    `With DRS, ${d.speechName} makes it look easy on ${d.victimSpeech}. P${d.position}.`,
                ]);
                if (d.underBraking) return pick([
                    `${d.speechName} dives down the inside under braking! P${d.position}.`,
                    `Late on the brakes and it works — ${d.speechName} takes P${d.position} from ${d.victimSpeech}.`,
                ]);
                if (d.boost) return pick([
                    `${d.speechName} rockets past ${d.victimSpeech} off the boost pad! P${d.position}.`,
                ]);
                if (d.teammate) return pick([
                    `Team-mates side by side — and ${d.speechName} comes out ahead for P${d.position}.`,
                    `${d.speechName} gets by their own team-mate ${d.victimSpeech}. That will be a tense debrief.`,
                ]);
                if (d.gripEdge > 0.05) return pick([
                    `The fresher rubber tells — ${d.speechName} breezes past ${d.victimSpeech} for P${d.position}.`,
                    `No contest on those tyres. ${d.speechName} takes P${d.position}.`,
                ]);
                return pick([
                    `${d.speechName} is through on ${d.victimSpeech} for P${d.position}!`,
                    `Position change! ${d.speechName} takes P${d.position}.`,
                    `${d.victimSpeech} has no answer — ${d.speechName} moves up to P${d.position}.`,
                ]);
            }

            case 'lead_change':
                return pick([
                    `We have a new race leader: ${d.speechName}!`,
                    `${d.speechName} is the new leader of this Grand Prix.`,
                ]);

            case 'fastest_lap':
                return d.finalHolder
                    ? pick([
                        `Fastest lap of the race for ${d.speechName} — ${spokenTime(d.time)}. Nobody beats that.`,
                        `${d.speechName} sets the benchmark: ${spokenTime(d.time)}, and it stands all afternoon.`,
                      ])
                    : pick([
                        `Purple sector — fastest lap for ${d.speechName}, ${spokenTime(d.time)}.`,
                        `${d.speechName} goes quickest of all, ${spokenTime(d.time)}.`,
                      ]);

            case 'pit_enter':
                if (d.reason === 'weather') return pick([
                    `${d.speechName} dives into the pit lane for the ${d.compound} tyre. Big call.`,
                    `Here comes ${d.speechName} — they're gambling on the ${d.compound}s.`,
                ]);
                if (d.reason === 'repairs') return pick([
                    `${d.speechName} limps into the pits for repairs. That race is in ruins.`,
                    `Unscheduled stop for ${d.speechName}. The damage was too much.`,
                ]);
                return pick([
                    `${d.speechName} peels into the pit lane from P${d.position}.`,
                    `Pit stop for ${d.speechName}, going onto the ${d.compound}.`,
                    `${d.speechName} has had enough of those tyres — into the pits.`,
                ]);

            case 'pit_exit':
                if (d.gainedPlaces > 0) return pick([
                    `Superb stop! ${d.speechName} rejoins having gained ${d.gainedPlaces} place${d.gainedPlaces > 1 ? 's' : ''}.`,
                    `The undercut works! ${d.speechName} comes out ahead in P${d.position}.`,
                ]);
                if (d.lostPlaces > 1) return pick([
                    `That has cost them — ${d.speechName} rejoins down in P${d.position}.`,
                    `Slow one there, and ${d.speechName} drops ${d.lostPlaces} places.`,
                ]);
                return pick([
                    `${d.speechName} back out on the ${d.compound}, P${d.position}.`,
                    `${d.speechName} rejoins in P${d.position} with fresh rubber.`,
                ]);

            case 'spin':
                return pick([
                    `${d.speechName} spins! ${d.cause}, and they're facing the wrong way!`,
                    `Round goes ${d.speechName}! That's a huge moment.`,
                    `${d.speechName} loses it — a spin from P${d.position}.`,
                ]);

            case 'crash':
                return pick([
                    `Contact! ${d.speechName} and ${d.otherSpeech} bang wheels!`,
                    `Oh, they've hit each other! ${d.speechName} into ${d.otherSpeech}.`,
                ]);

            case 'contact':
                return pick([
                    `Wheel to wheel, ${d.speechName} and ${d.otherSpeech} rubbing paint.`,
                    `A touch between ${d.speechName} and ${d.otherSpeech}. No love lost.`,
                ]);

            case 'dnf':
                return pick([
                    `And that's the end of the race for ${d.speechName} — ${d.reason}.`,
                    `Heartbreak for ${d.speechName}. ${d.reason} on lap ${d.lap}.`,
                    `${d.speechName} is out. ${d.reason}.`,
                ]);

            case 'mech_issue':
                return pick([
                    `${d.speechName} is ${d.issue}. They're in trouble out there.`,
                    `Problem for ${d.speechName} — ${d.issue}.`,
                ]);

            case 'sc_deploy':
                return pick([
                    `Safety car! Safety car deployed on lap ${d.lap}. The field is about to bunch up.`,
                    `The safety car is out, and that throws this race wide open.`,
                ]);

            case 'sc_end':
                return pick([
                    `Safety car in this lap — we go green, and it is a one-lap sprint from here.`,
                    `Green flag! Racing resumes and the gaps are gone.`,
                ]);

            case 'weather_change':
                if (/RAIN/.test(d.to)) return pick([
                    `And it's starting to rain! ${d.to} over the circuit. This changes everything.`,
                    `Here comes the weather — ${d.to}. Everyone's strategy just went out the window.`,
                ]);
                if (d.to === 'DRY') return pick([
                    `The track is drying out. Time to think about slicks.`,
                    `A dry line is appearing — the crossover point is coming.`,
                ]);
                return pick([
                    `Conditions changing: ${d.to} out there now.`,
                ]);

            case 'final_lap':
                return Number.isFinite(d.gap) && d.gap < 1.2
                    ? pick([
                        `Final lap! And it is nowhere near settled — ${d.chaserSpeech} is right on the gearbox of ${d.leaderSpeech}!`,
                        `Last lap, and this is going down to the wire!`,
                      ])
                    : pick([
                        `Final lap. ${d.leaderSpeech} leads them onto the last tour.`,
                        `One lap to go, and ${d.leaderSpeech} is in control.`,
                      ]);

            case 'chequered':
                return d.margin < 0.6
                    ? pick([
                        `${d.speechName} wins it! By a nose! What a finish!`,
                        `Photo finish — and it is ${d.speechName} who takes the flag!`,
                      ])
                    : pick([
                        `${d.speechName} takes the chequered flag and wins at ${meta.trackName}!`,
                        `Victory for ${d.speechName}! A brilliant drive.`,
                      ]);

            case 'race_end':
                return pick([
                    `That's the race. ${d.winnerSpeech} wins it. Head to the comments and tell us where the development points should go.`,
                    `Race over. ${d.winnerSpeech} on the top step — now it's your turn: vote for the upgrades in the comments.`,
                ]);

            case 'battle':
                return pick([
                    `A real scrap for P${d.position} — ${d.speechName} all over the back of ${d.aheadSpeech}.`,
                    `${d.speechName} is hunting ${d.aheadSpeech} for P${d.position}. Less than half a second.`,
                ]);

            case 'tyre_critical':
                return pick([
                    `${d.speechName} is running out of tyre. Those ${d.compound}s are done.`,
                    `Look at the pace drop from ${d.speechName} — the rubber has given up.`,
                ]);

            case 'podium_note':
                return pick([
                    `${d.speechName} completes the podium in P${d.position}.`,
                    `P${d.position} for ${d.speechName}.`,
                ]);

            case 'boost':
                return pick([`${d.speechName} picks up the boost.`]);

            case 'oil_hit':
                return pick([`${d.speechName} finds the oil and loses momentum.`]);

            case 'drs_armed':
                return pick([`${d.speechName} is within DRS range.`]);

            default:
                return null;
        }
    }

    // -------------------------------------------------------------------------
    // Plan building
    // -------------------------------------------------------------------------

    /**
     * @param {Array}  events analysed event log from Sim.runHeadless()
     * @param {object} meta   { trackName, seed, totalLaps, duration }
     */
    function load(events, meta) {
        rng = Rng.create((meta.seed ^ 0x9e3779b9) >>> 0);
        plan = [];
        for (const e of events) {
            if (!e.speakable) continue;
            const text = writeLine(e, meta);
            if (!text) continue;
            plan.push({
                t: e.t,
                text,
                type: e.type,
                significance: e.significance,
                badge: BADGES[e.type] || null,
                data: e.data,
            });
        }
        plan.sort((a, b) => a.t - b.t);
        reset();
    }

    function reset() {
        cursor = 0;
        queue = [];
        current = null;
        ticker.length = 0;
        lastSpokeAt = -99999;
        nextFillerAt = 16000;
        if (synth) synth.cancel();
    }

    function setLiveProvider(fn) { liveProvider = fn; }

    // -------------------------------------------------------------------------
    // Playback
    // -------------------------------------------------------------------------

    /** Rough spoken duration so subtitles hold for the right amount of time. */
    function estimateMs(text) {
        const words = text.split(/\s+/).length;
        return 420 + (words / voiceRate) * 340;
    }

    function speak(text, opts = {}) {
        const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
        current = {
            text,
            badge: opts.badge || null,
            type: opts.type || 'note',
            significance: opts.significance || 40,
            startedAt: now,
            until: now + estimateMs(text),
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
            u.onend = () => { if (current && current.text === text) current.until = Math.min(current.until, (typeof performance !== 'undefined' ? performance.now() : Date.now()) + 250); };
            synth.speak(u);
        } catch (err) {
            /* speech is a nice-to-have; subtitles carry the broadcast */
        }
    }

    /** Interrupt whatever is being said. */
    function cut() {
        if (synth) synth.cancel();
        current = null;
    }

    /** Push a line straight to the announcer (used for phase transitions). */
    function say(text, significance = 90, badge = null) {
        cut();
        speak(text, { significance, badge, type: 'note' });
        lastSpokeAt = 0;
    }

    /**
     * @param {number} simTimeMs current race time
     * @param {boolean} running  false while paused / between phases
     */
    function update(simTimeMs, running) {
        const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
        if (current && now >= current.until) current = null;

        if (!running) return;

        // Pull everything that has come due into the queue.
        while (cursor < plan.length && plan[cursor].t <= simTimeMs) {
            queue.push(plan[cursor]);
            cursor++;
        }

        // Drop stale entries — nobody wants to hear about a pass from ten seconds ago.
        queue = queue.filter(item => simTimeMs - item.t < 5200);
        if (!queue.length) {
            _maybeFiller(simTimeMs);
            return;
        }

        queue.sort((a, b) => b.significance - a.significance || a.t - b.t);

        if (current) {
            // Only a much bigger story gets to interrupt.
            if (queue[0].significance > current.significance + 18) {
                const item = queue.shift();
                cut();
                speak(item.text, item);
                lastSpokeAt = simTimeMs;
            }
            return;
        }

        const item = queue.shift();
        speak(item.text, item);
        lastSpokeAt = simTimeMs;
        nextFillerAt = simTimeMs + 13000 + rng.next() * 7000;
    }

    /** When the race goes quiet, give the viewer a status update. */
    function _maybeFiller(simTimeMs) {
        if (current || !liveProvider) return;
        if (simTimeMs < nextFillerAt) return;
        nextFillerAt = simTimeMs + 15000 + rng.next() * 9000;

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
        }
        if (live.weatherLabel && live.weatherLabel !== 'DRY') {
            options.push(`Still ${live.weatherLabel.toLowerCase()} out there, and the drivers are struggling for grip.`);
        }
        const mover = live.order.slice().sort((a, b) => b.overtakes - a.overtakes)[0];
        if (mover && mover.overtakes >= 2) {
            options.push(`${mover.speechName} has made ${mover.overtakes} passes so far — the mover of the race.`);
        }
        const worn = live.order.filter(c => c.tyreWear > 0.7 && !c.inPitLane)[0];
        if (worn) options.push(`${worn.speechName} is asking a lot of those tyres now.`);

        speak(options[Math.floor(rng.next() * options.length)], { significance: 25, type: 'gap_note' });
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
        listVoices, setVoiceByName, fmtTime, BADGES,
    };
})();
