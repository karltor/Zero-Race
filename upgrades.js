/**
 * Garage — the meta-game that makes every team drift apart over a season.
 *
 * After each race every team earns development points (win, podium, fastest
 * lap, most overtakes, ...). Viewers decide where those points go by writing
 * something like "blue brakes" in the YouTube comments; paste the comments in
 * and the votes are tallied and spent.
 *
 * All state lives in localStorage under ZR_STORAGE_KEY so a channel can run a
 * whole season from one browser profile.
 */
const Garage = (() => {

    const STORAGE_KEY = 'zeroRace.season.v1';
    const TEAMS = ['blue', 'yellow', 'red', 'green'];
    const MAX_LEVEL = 6;

    /**
     * Upgrade catalog. `per` is the effect of ONE level; the sim reads the
     * accumulated multipliers through Garage.getModifiers(team).
     *
     * Keep the aliases list generous — viewers will not type the canonical id.
     */
    const CATALOG = [
        {
            id: 'engine', name: 'Engine', icon: '⚙',
            blurb: 'Raw top speed on the straights.',
            aliases: ['engine', 'motor', 'power', 'topspeed', 'top speed', 'speed', 'hp', 'horsepower'],
        },
        {
            id: 'gearbox', name: 'Gearbox', icon: '⇢',
            blurb: 'Acceleration out of slow corners.',
            aliases: ['gearbox', 'gears', 'accel', 'acceleration', 'launch', 'transmission', 'box'],
        },
        {
            id: 'brakes', name: 'Brakes', icon: '⬤',
            blurb: 'Later braking — the classic overtaking weapon.',
            aliases: ['brakes', 'brake', 'braking', 'stoppers', 'discs'],
        },
        {
            id: 'aero', name: 'Aero', icon: '◤',
            blurb: 'Downforce: higher corner speed.',
            aliases: ['aero', 'downforce', 'wing', 'wings', 'cornering', 'corners', 'grip'],
        },
        {
            id: 'tyres', name: 'Tyre Management', icon: '◍',
            blurb: 'Rubber lasts longer — fewer or later pit stops.',
            aliases: ['tyres', 'tires', 'tyre', 'tire', 'rubber', 'wear', 'degradation', 'deg'],
        },
        {
            id: 'pitcrew', name: 'Pit Crew', icon: '🔧',
            blurb: 'Faster stationary time in the pit box.',
            aliases: ['pitcrew', 'pit crew', 'pit', 'pits', 'pitstop', 'pit stop', 'crew', 'mechanics'],
        },
        {
            id: 'reliability', name: 'Reliability', icon: '🛡',
            blurb: 'Fewer mechanical failures and less crash damage.',
            aliases: ['reliability', 'reliable', 'durability', 'strength', 'build', 'quality'],
        },
        {
            id: 'wet', name: 'Wet Setup', icon: '☂',
            blurb: 'Confidence in the rain.',
            aliases: ['wet', 'rain', 'wets', 'wet setup', 'monsoon', 'water'],
        },
    ];

    const CATALOG_BY_ID = Object.fromEntries(CATALOG.map(u => [u.id, u]));

    /** One upgrade level is worth this much. Deliberately small — a season should take many races. */
    const PER_LEVEL = {
        engine:      { topSpeed:  0.018 },
        gearbox:     { accel:     0.030 },
        brakes:      { braking:   0.028 },
        aero:        { cornering: 0.024 },
        tyres:       { tyreWear: -0.070 },
        pitcrew:     { pitTime:  -0.075 },
        reliability: { failure:  -0.130, damage: -0.090 },
        wet:         { wetGrip:   0.030 },
    };

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    function _blankTeam() {
        const upgrades = {};
        for (const u of CATALOG) upgrades[u.id] = 0;
        return {
            upgrades,
            bank: 0,              // unspent development points
            championship: 0,      // season points
            wins: 0,
            podiums: 0,
            fastestLaps: 0,
            overtakes: 0,
            races: 0,
        };
    }

    function _blankSeason() {
        const teams = {};
        for (const t of TEAMS) teams[t] = _blankTeam();
        return { raceNumber: 1, teams, history: [] };
    }

    let season = _blankSeason();

    function load() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) { season = _blankSeason(); return season; }
            const parsed = JSON.parse(raw);
            const fresh = _blankSeason();
            fresh.raceNumber = parsed.raceNumber || 1;
            fresh.history = Array.isArray(parsed.history) ? parsed.history.slice(-40) : [];
            for (const t of TEAMS) {
                const src = (parsed.teams && parsed.teams[t]) || {};
                const dst = fresh.teams[t];
                for (const u of CATALOG) {
                    const lvl = (src.upgrades && src.upgrades[u.id]) || 0;
                    dst.upgrades[u.id] = Math.max(0, Math.min(MAX_LEVEL, lvl | 0));
                }
                dst.bank         = Math.max(0, src.bank | 0);
                dst.championship = Math.max(0, src.championship | 0);
                dst.wins         = Math.max(0, src.wins | 0);
                dst.podiums      = Math.max(0, src.podiums | 0);
                dst.fastestLaps  = Math.max(0, src.fastestLaps | 0);
                dst.overtakes    = Math.max(0, src.overtakes | 0);
                dst.races        = Math.max(0, src.races | 0);
            }
            season = fresh;
        } catch (err) {
            console.warn('[garage] could not read saved season, starting fresh', err);
            season = _blankSeason();
        }
        return season;
    }

    function save() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(season));
        } catch (err) {
            console.warn('[garage] could not save season', err);
        }
    }

    function reset() {
        season = _blankSeason();
        save();
    }

    function getSeason()      { return season; }
    function getTeam(team)    { return season.teams[team]; }
    function getRaceNumber()  { return season.raceNumber; }

    // -------------------------------------------------------------------------
    // Derived modifiers — what the simulation actually consumes
    // -------------------------------------------------------------------------

    /**
     * Accumulated multipliers/offsets for a team.
     * The sim treats these as: stat *= (1 + mod), except `failure`/`pitTime`
     * which are also multiplicative but usually negative.
     */
    function getModifiers(team) {
        const mods = {
            topSpeed: 0, accel: 0, braking: 0, cornering: 0,
            tyreWear: 0, pitTime: 0, failure: 0, damage: 0, wetGrip: 0,
        };
        const t = season.teams[team];
        if (!t) return mods;
        for (const u of CATALOG) {
            const lvl = t.upgrades[u.id] || 0;
            if (!lvl) continue;
            const per = PER_LEVEL[u.id];
            for (const k in per) mods[k] += per[k] * lvl;
        }
        return mods;
    }

    /** Snapshot used by the simulation so a headless run and a live run agree. */
    function snapshotModifiers() {
        const out = {};
        for (const t of TEAMS) out[t] = getModifiers(t);
        return out;
    }

    function totalLevels(team) {
        const t = season.teams[team];
        if (!t) return 0;
        return CATALOG.reduce((sum, u) => sum + (t.upgrades[u.id] || 0), 0);
    }

    // -------------------------------------------------------------------------
    // Awarding points
    // -------------------------------------------------------------------------

    const CHAMPIONSHIP_POINTS = [10, 8, 6, 5, 4, 3, 2, 1];

    /**
     * Turn a finished race into development points + championship points.
     * @param {object} result see Sim.getResult()
     * @returns {object} breakdown per team: [{team, reasons:[{label, pts}], total}]
     */
    function applyRaceResult(result) {
        const breakdown = {};
        for (const t of TEAMS) breakdown[t] = { team: t, reasons: [], total: 0 };

        const add = (team, label, pts) => {
            if (!breakdown[team] || pts <= 0) return;
            breakdown[team].reasons.push({ label, pts });
            breakdown[team].total += pts;
        };

        // Finishing order → development + championship points
        result.standings.forEach((entry, i) => {
            const t = entry.team;
            season.teams[t].championship += CHAMPIONSHIP_POINTS[i] || 0;
            if (i === 0) { add(t, 'Race win', 5); season.teams[t].wins++; }
            else if (i === 1) add(t, 'P2 finish', 3);
            else if (i === 2) add(t, 'P3 finish', 2);
            else add(t, `P${i + 1} finish`, 1);
            if (i < 3) season.teams[t].podiums++;
        });

        if (result.fastestLap)  { add(result.fastestLap.team, 'Fastest lap', 3); season.teams[result.fastestLap.team].fastestLaps++; }
        if (result.mostOvertakes && result.mostOvertakes.overtakes > 0) add(result.mostOvertakes.team, 'Most overtakes', 3);
        if (result.mostBoosters && result.mostBoosters.count > 0)       add(result.mostBoosters.team, 'Most boost pads', 2);
        if (result.cleanestTeam) add(result.cleanestTeam, 'Cleanest race', 2);

        for (const t of TEAMS) {
            season.teams[t].bank += breakdown[t].total;
            season.teams[t].races++;
            season.teams[t].overtakes += (result.overtakesByTeam && result.overtakesByTeam[t]) || 0;
        }

        season.history.push({
            race: season.raceNumber,
            seed: result.seed,
            winner: result.standings[0] ? result.standings[0].name : '--',
            fastestLap: result.fastestLap ? result.fastestLap.name : '--',
        });
        if (season.history.length > 40) season.history.shift();

        season.raceNumber++;
        save();
        return breakdown;
    }

    // -------------------------------------------------------------------------
    // Spending
    // -------------------------------------------------------------------------

    /** Cost of taking `upgradeId` from its current level to the next one. */
    function costFor(team, upgradeId) {
        const lvl = season.teams[team].upgrades[upgradeId] || 0;
        if (lvl >= MAX_LEVEL) return Infinity;
        return 2 + lvl * 2;   // 2, 4, 6, 8, 10, 12
    }

    function canBuy(team, upgradeId) {
        return season.teams[team].bank >= costFor(team, upgradeId);
    }

    function buy(team, upgradeId) {
        if (!CATALOG_BY_ID[upgradeId]) return false;
        const cost = costFor(team, upgradeId);
        if (!Number.isFinite(cost) || season.teams[team].bank < cost) return false;
        season.teams[team].bank -= cost;
        season.teams[team].upgrades[upgradeId]++;
        save();
        return true;
    }

    // -------------------------------------------------------------------------
    // Comment vote parsing
    // -------------------------------------------------------------------------

    /**
     * Parse pasted YouTube comments into per-team upgrade votes.
     * A line counts if it mentions exactly one team and at least one upgrade.
     * Returns { votes: {team: {upgradeId: count}}, counted, ignored }
     */
    function parseVotes(text) {
        const votes = {};
        for (const t of TEAMS) votes[t] = {};
        let counted = 0, ignored = 0;

        const lines = String(text || '').split(/[\r\n]+/);
        for (const rawLine of lines) {
            const line = rawLine.toLowerCase();
            if (!line.trim()) continue;

            const teamsFound = TEAMS.filter(t => new RegExp(`\\b${t}\\b`).test(line));
            if (teamsFound.length !== 1) { if (line.trim()) ignored++; continue; }

            // Longest alias first so "top speed" wins over "speed"
            let found = null, foundAt = Infinity, foundLen = 0;
            for (const u of CATALOG) {
                for (const alias of u.aliases) {
                    const idx = line.indexOf(alias);
                    if (idx < 0) continue;
                    if (idx < foundAt || (idx === foundAt && alias.length > foundLen)) {
                        found = u.id; foundAt = idx; foundLen = alias.length;
                    }
                }
            }
            if (!found) { ignored++; continue; }

            const team = teamsFound[0];
            votes[team][found] = (votes[team][found] || 0) + 1;
            counted++;
        }
        return { votes, counted, ignored };
    }

    /**
     * Spend each team's bank following the vote ranking, buying the most
     * popular affordable upgrade repeatedly until the bank runs dry.
     * Returns a list of what was actually bought.
     */
    function applyVotes(votes) {
        const applied = [];
        for (const team of TEAMS) {
            const ranked = Object.entries(votes[team] || {})
                .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
            if (!ranked.length) continue;

            let guard = 0;
            let progress = true;
            while (progress && guard++ < 60) {
                progress = false;
                for (const [upgradeId, count] of ranked) {
                    if (buy(team, upgradeId)) {
                        applied.push({ team, upgradeId, votes: count, level: season.teams[team].upgrades[upgradeId] });
                        progress = true;
                        break;   // restart from the most popular option
                    }
                }
            }
        }
        save();
        return applied;
    }

    /** Fallback when nobody voted: spend on the team's weakest area. */
    function autoSpend(team) {
        const applied = [];
        let guard = 0;
        while (guard++ < 30) {
            const opts = CATALOG
                .map(u => ({ id: u.id, lvl: season.teams[team].upgrades[u.id] || 0 }))
                .filter(o => canBuy(team, o.id))
                .sort((a, b) => a.lvl - b.lvl || a.id.localeCompare(b.id));
            if (!opts.length) break;
            if (buy(team, opts[0].id)) {
                applied.push({ team, upgradeId: opts[0].id, votes: 0, level: season.teams[team].upgrades[opts[0].id] });
            } else break;
        }
        return applied;
    }

    function championshipTable() {
        return TEAMS
            .map(t => ({ team: t, ...season.teams[t] }))
            .sort((a, b) => b.championship - a.championship || b.wins - a.wins);
    }

    load();

    return {
        TEAMS, CATALOG, CATALOG_BY_ID, MAX_LEVEL,
        load, save, reset, getSeason, getTeam, getRaceNumber,
        getModifiers, snapshotModifiers, totalLevels,
        applyRaceResult, costFor, canBuy, buy,
        parseVotes, applyVotes, autoSpend, championshipTable,
    };
})();
