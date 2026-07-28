/**
 * Car: 2D physics, tyre/damage model and tactical AI.
 *
 * Everything in here is deterministic — the only randomness comes from the
 * seeded stream handed in through the context object.
 *
 * Driving model, briefly:
 *   grip        = compound × wear × surface × damage        (0.6 … 1.1)
 *   cornerSpeed = f(curvature ahead, cornering stat × grip)
 *   braking     = f(braking stat × grip)
 * so a worn tyre in the rain is slow *and* hard to slow down — which is what
 * turns a weather change into a pile of overtakes.
 */

/** Tyre compounds. `grip`/`wetGrip` are blended by track wetness. */
const TYRES = {
    soft:   { key: 'soft',   name: 'SOFT',   short: 'S', color: '#ff3b3b', grip: 1.055, wetGrip: 0.50, wear: 1.55, dryPenalty: 0   },
    medium: { key: 'medium', name: 'MEDIUM', short: 'M', color: '#ffd93b', grip: 1.000, wetGrip: 0.52, wear: 1.00, dryPenalty: 0   },
    hard:   { key: 'hard',   name: 'HARD',   short: 'H', color: '#e9e9e9', grip: 0.952, wetGrip: 0.55, wear: 0.66, dryPenalty: 0   },
    inter:  { key: 'inter',  name: 'INTER',  short: 'I', color: '#3ddc6b', grip: 0.905, wetGrip: 1.02, wear: 1.05, dryPenalty: 1.6 },
    wet:    { key: 'wet',    name: 'WET',    short: 'W', color: '#3b8dff', grip: 0.840, wetGrip: 1.20, wear: 0.95, dryPenalty: 2.2 },
};

/** Seconds of life for a compound with wear = 1.0 driven at a neutral pace. */
const TYRE_LIFE = 140;

const NUMBER_WORDS = { 1: 'One', 2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven', 8: 'Eight' };

/**
 * Returns a point on the perimeter of a rounded rectangle at fractional position t (0–1),
 * going clockwise from the top-left corner. hw/hh = half-width/height, cr = corner radius.
 */
function _carPerimPt(t, hw, hh, cr) {
    const sH = 2 * (hw - cr);
    const sV = 2 * (hh - cr);
    const ca = (Math.PI / 2) * cr;
    const total = 2 * sH + 2 * sV + 4 * ca;
    let d = ((t % 1) + 1) % 1 * total;

    if (d < ca) { const a = Math.PI + (d / ca) * (Math.PI / 2); return { x: (-hw + cr) + cr * Math.cos(a), y: (-hh + cr) + cr * Math.sin(a) }; }
    d -= ca;
    if (d < sH) { return { x: -hw + cr + d, y: -hh }; }
    d -= sH;
    if (d < ca) { const a = 3 * Math.PI / 2 + (d / ca) * (Math.PI / 2); return { x: (hw - cr) + cr * Math.cos(a), y: (-hh + cr) + cr * Math.sin(a) }; }
    d -= ca;
    if (d < sV) { return { x: hw, y: -hh + cr + d }; }
    d -= sV;
    if (d < ca) { const a = (d / ca) * (Math.PI / 2); return { x: (hw - cr) + cr * Math.cos(a), y: (hh - cr) + cr * Math.sin(a) }; }
    d -= ca;
    if (d < sH) { return { x: hw - cr - d, y: hh }; }
    d -= sH;
    if (d < ca) { const a = Math.PI / 2 + (d / ca) * (Math.PI / 2); return { x: (-hw + cr) + cr * Math.cos(a), y: (hh - cr) + cr * Math.sin(a) }; }
    d -= ca;
    return { x: -hw, y: hh - cr - d };
}

/**
 * Per-number driver personality. `aggression` drives overtake appetite,
 * `consistency` how much random pace variation they carry, `risk` how likely
 * they are to bin it when grip is low.
 */
const CAR_PROFILES = {
    1: { topSpeed: 1.03, accel: 1.00, braking: 1.00, cornering: 1.00, aggression: 0.50, consistency: 0.92, risk: 0.45, tyreCare: 1.00 },
    2: { topSpeed: 0.98, accel: 0.96, braking: 1.12, cornering: 1.05, aggression: 0.30, consistency: 0.96, risk: 0.25, tyreCare: 0.86 },
    3: { topSpeed: 1.08, accel: 1.04, braking: 0.92, cornering: 0.90, aggression: 0.60, consistency: 0.84, risk: 0.70, tyreCare: 1.18 },
    4: { topSpeed: 1.01, accel: 1.10, braking: 1.00, cornering: 0.96, aggression: 0.70, consistency: 0.88, risk: 0.60, tyreCare: 1.08 },
    5: { topSpeed: 0.97, accel: 0.96, braking: 1.04, cornering: 1.14, aggression: 0.40, consistency: 0.94, risk: 0.30, tyreCare: 0.90 },
    6: { topSpeed: 1.01, accel: 1.00, braking: 1.12, cornering: 0.98, aggression: 0.75, consistency: 0.86, risk: 0.65, tyreCare: 1.10 },
    7: { topSpeed: 1.00, accel: 1.02, braking: 1.02, cornering: 1.02, aggression: 0.35, consistency: 0.97, risk: 0.28, tyreCare: 0.82 },
    8: { topSpeed: 1.05, accel: 1.00, braking: 0.95, cornering: 0.96, aggression: 0.85, consistency: 0.80, risk: 0.85, tyreCare: 1.22 },
};

/** True when the car passes `mark` moving forward from `prev` to `now`. */
function _crossedMark(prev, now, mark) {
    const d = Track.forwardDist(prev, now);
    if (d <= 0 || d > 0.5) return false;
    return Track.forwardDist(prev, mark) <= d;
}

class Car {
    /**
     * @param {string} team
     * @param {number} number
     * @param {object} opts { rng, mods } — mods from Garage.getModifiers(team)
     */
    constructor(team, number, opts = {}) {
        this.team = team;
        this.number = number;
        this.id = `${team}${number}`;
        this.name = `${team.charAt(0).toUpperCase() + team.slice(1)} #${number}`;
        this.shortName = `${team.charAt(0).toUpperCase()}${number}`;
        // Written out for the text-to-speech announcer — "#" reads terribly.
        this.speechName = `${team.charAt(0).toUpperCase() + team.slice(1)} ${NUMBER_WORDS[number] || number}`;
        this.image = (typeof CarSVG !== 'undefined') ? CarSVG.getImage(team, number) : null;

        const rng = opts.rng || Rng.create(1);
        this.mods = opts.mods || { topSpeed: 0, accel: 0, braking: 0, cornering: 0, tyreWear: 0, pitTime: 0, failure: 0, damage: 0, wetGrip: 0 };

        const profile = CAR_PROFILES[number];
        this.profile = profile;
        this.stats = {
            topSpeed:  profile.topSpeed  * (1 + this.mods.topSpeed),
            accel:     profile.accel     * (1 + this.mods.accel),
            braking:   profile.braking   * (1 + this.mods.braking),
            cornering: profile.cornering * (1 + this.mods.cornering),
            aggression: profile.aggression,
        };

        // Per-car racing-line personality, rolled once from the seeded stream.
        this.apexCut      = 0.35 + rng.next() * 0.45 * this.stats.cornering;
        this.lineVariance = (rng.next() - 0.5) * 0.22;
        // A small permanent pace offset so identical stats still produce a pecking order.
        this.formOffset   = 1 + rng.gauss() * 0.006 * (2 - profile.consistency);
        this.pitThreshold = 0.70 + rng.float(-0.06, 0.10);
        this._rng = rng;

        this.collisionRadius = 18;
        this.reset();
    }

    /** Full per-race reset (keeps identity and personality). */
    reset() {
        this.x = 0; this.y = 0;
        this.angle = 0;
        this.speed = 0;

        this.trackIndex = 0;
        this.progress = 0;
        this.prevProgress = 0;
        this.lap = 0;
        this.totalProgress = 0;
        this.position = 0;
        this.gridPosition = 0;

        this.lapStartTime = 0;
        this.bestLapTime = Infinity;
        this.currentLapTime = 0;
        this.lastLapTime = 0;
        this.lapTimes = [];
        this.sectorTimes = [];
        this._sectorStart = 0;
        this._sectorIdx = 0;

        // AI state
        this.targetLane = 0;
        this.overtakeTimer = 0;
        this.overtakeSide = 0;
        this.defendTimer = 0;
        this.blocked = false;
        this.braking = false;
        this.slipstreaming = false;
        this.offTrack = false;
        this.ahead = null;
        this.gapAheadPx = Infinity;
        this.gapAheadSec = Infinity;

        // Tyres
        this.tyre = TYRES.medium;
        this.tyreWear = 0;
        this.stints = [];
        this.pitStops = 0;

        // Pit state machine
        this.pitState = 'none';       // none | requested | inlane | stopped | exiting
        this.pitTimer = 0;
        this.pitBox = 0;
        this.pitLaneBlend = 0;        // 0 = racing line, 1 = fully in the pit lane
        this.inPitLane = false;
        this.nextCompound = null;
        this._pitReason = '';
        this._pitPositionIn = 0;

        // DRS
        this.drsArmed = false;
        this.drsActive = false;
        this.drsZone = null;

        // Damage / incidents
        this.damage = 0;
        this.spinTimer = 0;
        this.spinRate = 0;
        this.mechFactor = 1;
        this.retired = false;
        this.dnfReason = '';

        // Power-ups
        this.boostTimer = 0;
        this.oilTimer = 0;
        this.catchupFactor = 0;

        this.stuckTimer = 0;
        this.lastTrackIdx = 0;
        this._lapTimingArmed = false;
        this._lapStartTotal = undefined;
        this._contactCooldown = 0;
        this._mechDone = false;
        this._tyreWarned = false;
        this._battleFor = 0;
        this._crossedLine = false;
        this._newPersonalBest = false;

        // Stats
        this.overtakes = 0;
        this.overtaken = 0;
        this.boostersCollected = 0;
        this.contacts = 0;
        this.spins = 0;
        this.placesGained = 0;

        // Presentation
        this._finishedRace = false;
        this._finishAlpha = 1.0;
        this._finishFadeDelay = 0;
        this.finishTime = 0;
    }

    // -------------------------------------------------------------------------
    // Setup
    // -------------------------------------------------------------------------

    placeOnTrack(progress, laneOffset) {
        this.progress = Track.wrap(progress);
        this.prevProgress = this.progress;
        this.lap = 0;
        this.totalProgress = this.progress;
        this._startProgress = this.progress;
        this.speed = 0;
        this.targetLane = laneOffset / (Track.getWidth() / 2);

        const pos = Track.getPositionAt(this.progress, laneOffset);
        this.x = pos.x;
        this.y = pos.y;
        this.angle = pos.angle;
        this.trackIndex = Math.floor(this.progress * Track.getPointCount());
        this.lastTrackIdx = this.trackIndex;
    }

    /** Fit a compound and start a fresh stint. */
    fitTyre(compound) {
        if (this.tyre && this.tyreWear > 0.02) {
            this.stints.push({ compound: this.tyre.key, endLap: this.lap, wear: this.tyreWear });
        }
        this.tyre = TYRES[compound] || TYRES.medium;
        this.tyreWear = 0;
    }

    // -------------------------------------------------------------------------
    // Derived performance
    // -------------------------------------------------------------------------

    /** Blended grip 0.5 … 1.15 — the single most important number in the sim. */
    grip(weather) {
        const w = weather ? weather.state.wetness : 0;
        const compound = this.tyre.grip * (1 - w) + this.tyre.wetGrip * w;
        const wearFactor = Math.max(0.60, 1 - 0.30 * Math.pow(this.tyreWear, 1.8));
        const wetSkill = 1 + this.mods.wetGrip * w;
        const damageFactor = 1 - this.damage * 0.14;
        return compound * wearFactor * wetSkill * damageFactor * (weather ? weather.surfaceGrip() : 1);
    }

    maxSpeed() {
        return 350 * this.stats.topSpeed * this.formOffset * this.mechFactor *
               (1 - this.damage * 0.12) * (1 + this.catchupFactor * 0.16);
    }

    /** How urgently this car needs new rubber, 0 … >1. */
    tyreUrgency(weather) {
        let u = this.tyreWear / Math.max(0.25, this.pitThreshold);
        const w = weather ? weather.state.wetness : 0;
        const isWetTyre = this.tyre.key === 'wet' || this.tyre.key === 'inter';
        if (w > 0.34 && !isWetTyre) u = Math.max(u, 1.05 + w);
        if (w < 0.14 && isWetTyre)  u = Math.max(u, 1.02);
        if (this.damage > 0.55)     u = Math.max(u, 1.30);
        return u;
    }

    /** Which compound this car would fit right now. */
    chooseCompound(ctx) {
        const w = ctx.weather ? ctx.weather.state.wetness : 0;
        if (w > 0.62) return 'wet';
        if (w > 0.28) return 'inter';
        const lapsLeft = Math.max(1, ctx.totalLaps - Math.max(0, this.lap));
        const lapSec = (this.bestLapTime && this.bestLapTime < Infinity ? this.bestLapTime : 13000) / 1000;
        const secondsLeft = lapsLeft * lapSec;
        const life = c => TYRE_LIFE / (TYRES[c].wear * this.profile.tyreCare * (1 + this.mods.tyreWear));

        // Cost model: every extra stop is worth roughly `stopCost` seconds,
        // and softer rubber buys lap time. Aggressive drivers discount stops.
        const stopCost = this.profile.aggression > 0.6 ? 15 : 21;
        let best = 'hard', bestScore = Infinity;
        for (const c of ['soft', 'medium', 'hard']) {
            const stops = Math.max(0, Math.ceil(secondsLeft / (life(c) * 0.95)) - 1);
            const pace = (1.055 - TYRES[c].grip) * 62;
            const score = stops * stopCost + pace;
            if (score < bestScore - 0.001) { bestScore = score; best = c; }
        }
        return best;
    }

    // -------------------------------------------------------------------------
    // Main update
    // -------------------------------------------------------------------------

    /**
     * @param {number} dt seconds
     * @param {object} ctx { cars, simTime, timeSinceStart, phase, weather,
     *                       safetyCar, events, rng, noCollisions, totalLaps }
     */
    update(dt, ctx) {
        if (this.retired) { this._updateRetired(dt); return; }
        if (this.lap === 0 && this.lapStartTime === 0) this.lapStartTime = ctx.simTime;

        this._updateTyres(dt, ctx);

        if (this.spinTimer > 0) {
            this._updateSpin(dt);
        } else {
            const ai = this.runAI(ctx, dt);
            this.applyPhysics(ai.throttle, ai.brake, ai.steer, dt, ctx);
        }

        if (!ctx.noCollisions && ctx.timeSinceStart > 3000) this.resolveCollisions(ctx);

        this.detectStuck(dt);
        // Progress first: the DRS and pit-lane state machines both work by
        // testing whether a marker was crossed between the previous position
        // and the current one, so they must run after the position moves.
        this.updateProgress(ctx);
        this._updateDrs(ctx);
        this._updatePit(dt, ctx);
        if (ctx.effects !== false) this.emitEffects(ctx);
    }

    _updateRetired(dt) {
        this.speed *= (1 - dt * 2.5);
        this.x += Math.cos(this.angle) * this.speed * dt;
        this.y += Math.sin(this.angle) * this.speed * dt;
        this.braking = false;
        this.drsActive = false;
    }

    _updateSpin(dt) {
        this.spinTimer -= dt;
        this.angle += this.spinRate * dt;
        this.speed *= (1 - dt * 2.2);
        this.x += Math.cos(this.angle) * this.speed * dt * 0.6;
        this.y += Math.sin(this.angle) * this.speed * dt * 0.6;
        this.braking = true;
        this.drsActive = false;
        if (this.spinTimer <= 0) {
            // Point the car back down the road so it can rejoin.
            const cl = Track.closestPointNear(this.x, this.y, this.trackIndex);
            this.angle = Track.angleAt(cl.index);
            this.speed = Math.max(this.speed, 40);
        }
    }

    _updateTyres(dt, ctx) {
        if (this.pitState === 'stopped') return;
        const w = ctx.weather ? ctx.weather.state.wetness : 0;
        const wearMul = (1 + this.tyre.dryPenalty * Math.max(0, 1 - w * 2.6));
        // Sliding around and heavy braking chew the tyre faster.
        const load = 0.75 + 0.5 * Math.min(1, this.speed / 320) + (this.braking ? 0.25 : 0);
        const rate = this.tyre.wear * wearMul * this.profile.tyreCare * (1 + this.mods.tyreWear) * load;
        this.tyreWear = Math.min(1.6, this.tyreWear + (dt / TYRE_LIFE) * rate);
    }

    _updateDrs(ctx) {
        const sc = ctx.safetyCar && ctx.safetyCar.active;
        const wetTrack = ctx.weather && ctx.weather.state.wetness > 0.35;
        if (sc || wetTrack || this.inPitLane || ctx.phase === 'qual' || this.lap < 1) {
            this.drsArmed = false; this.drsActive = false; this.drsZone = null;
            return;
        }

        // Detection lines arm DRS for the zone they belong to.
        for (const z of Track.getDrsZones()) {
            if (_crossedMark(this.prevProgress, this.progress, z.detect)) {
                this.drsArmed = this.gapAheadSec < 1.0 && this.gapAheadSec > 0;
                this.drsZone = this.drsArmed ? z : null;
            }
        }

        this.drsActive = !!(this.drsArmed && this.drsZone &&
                            Track.inRange(this.progress, this.drsZone.start, this.drsZone.end));
        if (this.drsZone && _crossedMark(this.prevProgress, this.progress, this.drsZone.end)) {
            this.drsArmed = false; this.drsZone = null; this.drsActive = false;
        }
    }

    // -------------------------------------------------------------------------
    // Pit stops
    // -------------------------------------------------------------------------

    _updatePit(dt, ctx) {
        const pit = Track.getPit();
        if (!pit || ctx.phase === 'qual') return;

        // ── Decide ──
        if (this.pitState === 'none' && this.lap >= 1 && this.lap < ctx.totalLaps - 1 && !this.retired) {
            const urgency = this.tyreUrgency(ctx.weather);
            // Under a safety car everyone dives in — the stop is nearly free.
            const scBonus = (ctx.safetyCar && ctx.safetyCar.active) ? 0.35 : 0;
            if (urgency + scBonus >= 1) {
                this.pitState = 'requested';
                this.nextCompound = this.chooseCompound(ctx);
                this._pitReason = this.damage > 0.55 ? 'repairs'
                                : (ctx.weather && ctx.weather.state.wetness > 0.34 && this.tyre.key !== 'wet' && this.tyre.key !== 'inter') ? 'weather'
                                : 'tyres';
            }
        }

        // ── Enter ──
        if (this.pitState === 'requested' && _crossedMark(this.prevProgress, this.progress, pit.entry)) {
            this.pitState = 'inlane';
            this.inPitLane = true;
            this.pitBox = pit.boxes[Math.min(pit.boxes.length - 1, this._boxIndex(ctx))];
            this._pitPositionIn = this.position;
            if (ctx.events) ctx.events.add(ctx.simTime, 'pit_enter', {
                carId: this.id, name: this.name, speechName: this.speechName, team: this.team,
                position: this.position, lap: this.lap + 1, reason: this._pitReason,
                compound: TYRES[this.nextCompound] ? TYRES[this.nextCompound].name : 'MEDIUM',
                unscheduled: this._pitReason === 'repairs',
            });
        }

        // ── Service ──
        if (this.pitState === 'stopped') {
            this.pitTimer -= dt;
            this.speed = 0;
            if (this.pitTimer <= 0) {
                this.fitTyre(this.nextCompound || 'medium');
                this.damage = Math.max(0, this.damage - 0.75);
                this.pitStops++;
                this.pitState = 'exiting';
                this.speed = 25;
            }
        }

        // ── Exit ──
        if (this.pitState === 'exiting' && _crossedMark(this.prevProgress, this.progress, pit.exit)) {
            this.pitState = 'none';
            this.inPitLane = false;
            this.nextCompound = null;
            if (ctx.events) ctx.events.add(ctx.simTime, 'pit_exit', {
                carId: this.id, name: this.name, speechName: this.speechName, team: this.team,
                position: this.position, compound: this.tyre.name,
                gainedPlaces: Math.max(0, this._pitPositionIn - this.position),
                lostPlaces: Math.max(0, this.position - this._pitPositionIn),
                stops: this.pitStops,
            });
        }

        this.inPitLane = this.pitState === 'inlane' || this.pitState === 'stopped' || this.pitState === 'exiting';
        const targetBlend = this.inPitLane ? 1 : 0;
        this.pitLaneBlend += (targetBlend - this.pitLaneBlend) * Math.min(1, dt * 3.2);
    }

    /** Every car owns one pit box so nobody parks on top of a team-mate. */
    _boxIndex(ctx) {
        const order = ['blue', 'yellow', 'red', 'green'].indexOf(this.team);
        return order * 2 + (this.number % 2 === 1 ? 0 : 1);
    }

    /** Stationary time in the box, in seconds. */
    _stopDuration() {
        const base = 2.35 * (1 + this.mods.pitTime);
        const repair = this.damage > 0.35 ? 1.4 + this.damage * 1.8 : 0;
        // Small deterministic variation — the odd slow stop is good television.
        const jitter = this._rng.float(-0.12, 0.55);
        return Math.max(1.3, base + repair + jitter);
    }

    // -------------------------------------------------------------------------
    // AI
    // -------------------------------------------------------------------------

    getCurveDirection(idx) {
        const n = Track.getPointCount();
        const pts = Track.getPoints();
        const look = 12;
        const p0 = pts[idx % n];
        const p1 = pts[(idx + look) % n];
        const p2 = pts[(idx + look * 2) % n];
        const cross = (p1.x - p0.x) * (p2.y - p1.y) - (p1.y - p0.y) * (p2.x - p1.x);
        return cross >= 0 ? 1 : -1;
    }

    maxCurvatureAhead(startPts, endPts) {
        const n = Track.getPointCount();
        let max = 0;
        const steps = 5;
        const span = Math.max(1, endPts - startPts);
        for (let s = 0; s <= steps; s++) {
            const offset = startPts + Math.round(span * s / steps);
            max = Math.max(max, Track.curvatureAt((this.trackIndex + offset) % n));
        }
        return max;
    }

    runAI(ctx, dt) {
        const allCars = ctx.cars;
        const n = Track.getPointCount();
        const tw = Track.getWidth();
        const grip = this.grip(ctx.weather);
        const maxSpeed = this.maxSpeed() * (this.drsActive ? 1.14 : 1);
        const isGrace = ctx.timeSinceStart < 3000;
        const isLap1 = this.lap === 0;
        const scActive = !!(ctx.safetyCar && ctx.safetyCar.active) && !this.inPitLane;

        // --- LOCATE ON TRACK ---
        const closest = Track.closestPointNear(this.x, this.y, this.trackIndex);
        this.trackIndex = closest.index;
        const norm = Track.normalAt(this.trackIndex);
        const cp = Track.getPoints()[this.trackIndex];
        const lateralOffset = (this.x - cp.x) * norm.x + (this.y - cp.y) * norm.y;
        this.lateralOffset = lateralOffset;
        this.offTrack = !this.inPitLane && Math.abs(lateralOffset) > tw * 0.45;

        // --- PHYSICS-BASED LOOK-AHEAD ---
        const brakingDecel = 450 * this.stats.braking * (0.55 + 0.45 * grip);
        const brakingPx = (this.speed * this.speed) / (2 * brakingDecel);
        const pxPerPt = Track.getTrackLength() / n;
        const brakePts = Math.max(12, Math.min(100, Math.round(brakingPx / pxPerPt * 1.2)));
        const nearPts = Math.max(4, Math.round(brakePts * 0.2));

        const maxCurv = this.maxCurvatureAhead(nearPts, brakePts);
        const curNear = this.maxCurvatureAhead(2, nearPts);
        const isOnStraight = maxCurv < 0.018;

        // --- CORNER SPEED (grip is the multiplier that makes tyres matter) ---
        const effCorner = this.stats.cornering * grip;
        let cornerSpeed = maxSpeed * Math.max(0.34, 1 - maxCurv * 3.2 / effCorner);

        // ── PIT LANE MODE: a completely different, much simpler brain ──
        if (this.inPitLane) return this._pitControl(ctx, lateralOffset, dt);

        // ── SAFETY CAR MODE ──
        if (scActive) {
            const scSpeed = ctx.safetyCar.speed;
            let target = scSpeed;
            if (this.ahead && this.gapAheadPx > 62) target = scSpeed * 1.55;
            else if (this.ahead && this.gapAheadPx < 42) target = scSpeed * 0.72;
            cornerSpeed = Math.min(cornerSpeed, target);
            this.targetLane *= 0.9;
            this.overtakeTimer = 0;
            this.defendTimer = 0;
        }

        // --- RACING LINE ---
        const curvAhead = this.maxCurvatureAhead(nearPts, Math.round(brakePts * 0.6));
        const approaching = curvAhead > curNear * 1.3 && curvAhead > 0.02;
        const exiting = curNear > curvAhead * 1.3 && curNear > 0.025;

        let racingLine = this.lineVariance;
        let cornerDir = 0;
        if (curNear > 0.018 || maxCurv > 0.018) {
            cornerDir = this.getCurveDirection(this.trackIndex);
            if (approaching)     racingLine = cornerDir * 0.38 + this.lineVariance;
            else if (exiting)    racingLine = cornerDir * 0.28 + this.lineVariance;
            else                 racingLine = -cornerDir * this.apexCut + this.lineVariance;
        }
        this.cornerDir = cornerDir;

        // --- TIMERS ---
        this.overtakeTimer = Math.max(0, this.overtakeTimer - dt);
        this.defendTimer   = Math.max(0, this.defendTimer - dt);
        const isOvertaking = this.overtakeTimer > 0;
        const isDefending  = this.defendTimer > 0;

        // --- TARGET LATERAL POSITION ---
        const laneTarget = (isOvertaking || isDefending)
            ? this.targetLane
            : racingLine * 0.6 + this.targetLane * 0.4;
        const desiredOffset = laneTarget * (tw * 0.3);

        // --- PURE PURSUIT STEERING ---
        const lookPts = Math.max(20, Math.round(this.speed * 0.13));
        const lookIdx = (this.trackIndex + lookPts) % n;
        const lookPt = Track.getPositionAt(lookIdx / n, desiredOffset);
        let angleErr = Math.atan2(lookPt.y - this.y, lookPt.x - this.x) - this.angle;
        while (angleErr > Math.PI) angleErr -= Math.PI * 2;
        while (angleErr < -Math.PI) angleErr += Math.PI * 2;

        let steer = angleErr * 2.2;
        if (Math.abs(lateralOffset) > tw * 0.4) steer += -(lateralOffset / tw) * 3.0;
        if (this.oilTimer > 0) steer *= 0.4;
        steer = Math.max(-1, Math.min(1, steer));

        // --- THROTTLE / BRAKE ---
        let throttle = 0, brake = 0;
        this.braking = false;

        const speedExcess = this.speed - cornerSpeed;
        if (speedExcess > 5) {
            brake = Math.min(0.95, speedExcess / (maxSpeed * 0.28) * this.stats.braking);
            throttle = 0;
            this.braking = true;
        } else if (speedExcess > -8) {
            throttle = 0.15 + Math.max(0, -speedExcess) / (maxSpeed * 0.15) * 0.35;
        } else {
            throttle = isOnStraight ? 1.0 : Math.min(1.0, 0.5 + (-speedExcess) / (maxSpeed * 0.3));
        }

        if (this.offTrack) { throttle = Math.min(throttle, 0.3); brake = Math.max(brake, 0.2); }
        if (this.oilTimer > 0) throttle = Math.min(throttle, 0.25);

        // --- SCAN NEARBY CARS ---
        this.blocked = false;
        this.slipstreaming = false;

        const cosA = Math.cos(this.angle), sinA = Math.sin(this.angle);
        let carAhead = null, carBehind = null, carAlongside = null;

        for (const other of allCars) {
            if (other === this || other.retired || other.inPitLane) continue;
            const dx = other.x - this.x, dy = other.y - this.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > 200) continue;

            const dotFwd = dx * cosA + dy * sinA;
            const dotSide = -dx * sinA + dy * cosA;
            const isTeam = other.team === this.team;

            if (isGrace) {
                if (dotFwd > 0 && dotFwd < 55 && Math.abs(dotSide) < 30) throttle = Math.min(throttle, 0.5);
                continue;
            }

            if (dotFwd > 35 && dotFwd < 150 && Math.abs(dotSide) < 26) this.slipstreaming = true;

            if (dotFwd > 0 && dotFwd < 110 && Math.abs(dotSide) < 28) {
                if (!carAhead || dotFwd < carAhead.fwd) carAhead = { car: other, dist, fwd: dotFwd, side: dotSide, isTeam };
            }
            if (dotFwd < 0 && dotFwd > -80 && Math.abs(dotSide) < 30) {
                if (!carBehind || -dotFwd < -carBehind.fwd) carBehind = { car: other, dist, fwd: dotFwd, side: dotSide, isTeam };
            }
            if (Math.abs(dotFwd) < 32 && Math.abs(dotSide) < 44 && dist < 50) {
                if (!carAlongside || dist < carAlongside.dist) carAlongside = { car: other, dist, fwd: dotFwd, side: dotSide, isTeam };
            }
        }

        if (isGrace) {
            if (this.slipstreaming) throttle = Math.min(1.0, throttle + 0.15);
            return { throttle, brake, steer };
        }

        // --- FOLLOWING / OVERTAKING ---
        if (carAhead) {
            const { fwd, side, isTeam } = carAhead;
            this.blocked = true;

            if (isOvertaking) {
                if (fwd < 22 && Math.abs(side) < 22) { throttle = Math.min(throttle, 0.25); brake = Math.max(brake, 0.4); }
            } else {
                if (fwd < 28) { throttle = 0; brake = Math.max(brake, Math.min(0.65, (28 - fwd) / 18)); }
                else if (fwd < 55) throttle = Math.min(throttle, 0.35 + (fwd - 28) / 60);
                else throttle = Math.min(throttle, 0.82);

                const canTryOvertake = !scActive && (!isLap1 || (!isTeam && this.stats.aggression > 0.7 && isOnStraight));

                if (this.overtakeTimer <= 0 && canTryOvertake) {
                    let commit = false;
                    let overtakeSide = side >= 0 ? -1 : 1;

                    // A tyre or DRS advantage makes a driver much braver.
                    const gripEdge = grip - carAhead.car.grip(ctx.weather);
                    const brave = this.stats.aggression + (this.drsActive ? 0.35 : 0) + Math.max(0, gripEdge) * 2.4;

                    if (isTeam) {
                        if (gripEdge > 0.02 && isOnStraight && fwd < 90) commit = true;
                    } else {
                        if (isOnStraight && brave > 0.3 && fwd < 105) commit = true;
                        if (this.stats.braking > 1.05 && !isOnStraight && maxCurv > 0.02 && maxCurv < 0.08) {
                            const futurePts = Math.round(brakePts * 0.6);
                            overtakeSide = -this.getCurveDirection((this.trackIndex + futurePts) % n);
                            commit = true;
                        }
                        if (brave > 0.65 && maxCurv < 0.055 && fwd < 90) commit = true;
                        if (this.stats.cornering > 1.08 && curNear > 0.02 && maxCurv < 0.02 && fwd < 90) commit = true;
                    }

                    if (commit) {
                        const targetOff = overtakeSide * (tw * 0.26);
                        if (Math.abs(targetOff - lateralOffset) > 8) {
                            this.overtakeSide = overtakeSide;
                            this.targetLane = overtakeSide * 0.82;
                            this.overtakeTimer = 2.0 + this._rng.next() * 0.8;
                        }
                    }
                }
            }
        } else if (isOvertaking) {
            this.overtakeTimer = 0;
        }

        // --- SIDE-BY-SIDE ---
        if (carAlongside && !isOvertaking) {
            steer = carAlongside.side > 0 ? Math.min(steer, -0.28) : Math.max(steer, 0.28);
        }

        // --- DEFENDING ---
        if (carBehind && !isOvertaking && !isLap1 && !scActive && this.defendTimer <= 0) {
            const { fwd, side, isTeam } = carBehind;
            if (!isTeam && -fwd < 50 && this.stats.aggression > 0.35 && maxCurv < 0.05) {
                this.targetLane = side > 0 ? 0.32 : -0.32;
                this.defendTimer = 0.9;
            }
        }

        if (!this.blocked && !isOvertaking && !isDefending) this.targetLane *= 0.93;
        if (this.slipstreaming) throttle = Math.min(1.0, throttle + 0.18);

        return { throttle, brake, steer };
    }

    /** Simplified controller used while the car is in the pit lane. */
    _pitControl(ctx, lateralOffset, dt) {
        const pit = Track.getPit();
        const n = Track.getPointCount();
        const limit = pit.speedLimit;

        // Aim at a point down the pit lane.
        const lookPts = Math.max(14, Math.round(this.speed * 0.12));
        const lookIdx = (this.trackIndex + lookPts) % n;
        const lookPt = Track.getPositionAt(lookIdx / n, pit.offset * this.pitLaneBlend);
        let angleErr = Math.atan2(lookPt.y - this.y, lookPt.x - this.x) - this.angle;
        while (angleErr > Math.PI) angleErr -= Math.PI * 2;
        while (angleErr < -Math.PI) angleErr += Math.PI * 2;
        const steer = Math.max(-1, Math.min(1, angleErr * 2.6));

        this.braking = false;
        let target = limit;

        if (this.pitState === 'inlane') {
            const distPx = Track.forwardDist(this.progress, this.pitBox) * Track.getTrackLength();
            if (distPx < 130) target = Math.min(target, Math.sqrt(Math.max(0, 2 * 260 * Math.max(0, distPx - 4))));
            if (distPx < 7 || distPx > Track.getTrackLength() * 0.5) {
                // Arrived (or just overshot) — snap into the box.
                const p = Track.getPositionAt(this.pitBox, pit.offset);
                this.x = p.x; this.y = p.y; this.angle = p.angle;
                this.speed = 0;
                this.pitState = 'stopped';
                this.pitTimer = this._stopDuration();
                this._stopLength = this.pitTimer;
                return { throttle: 0, brake: 1, steer: 0 };
            }
        }

        if (this.pitState === 'stopped') return { throttle: 0, brake: 1, steer: 0 };

        const excess = this.speed - target;
        let throttle = 0, brake = 0;
        if (excess > 3) { brake = Math.min(1, excess / 60); this.braking = true; }
        else throttle = Math.min(1, 0.35 + (-excess) / 90);

        return { throttle, brake, steer };
    }

    // -------------------------------------------------------------------------
    // Physics
    // -------------------------------------------------------------------------

    applyPhysics(throttle, brake, steer, dt, ctx) {
        const grip = this.grip(ctx.weather);
        const baseMaxSpeed = this.maxSpeed();
        const maxSpeed = baseMaxSpeed * (this.drsActive ? 1.14 : 1);
        const accel = 220 * this.stats.accel * this.mechFactor * (this.drsActive ? 1.18 : 1);
        const brkForce = 450 * this.stats.braking * (0.55 + 0.45 * grip);
        const engBrake = 30;
        const drag = 0.15;
        const steerRate = 3.0;

        this.brakeAmount = brake;
        let force = throttle * accel - brake * brkForce - engBrake - this.speed * drag;

        if (this.boostTimer > 0) {
            this.boostTimer -= dt;
            force += accel * 1.0;
        }

        const cap = this.inPitLane ? Track.getPit().speedLimit * 1.05
                                   : maxSpeed * (this.boostTimer > 0 ? 1.35 : 1);
        this.speed = Math.max(0, Math.min(cap, this.speed + force * dt));

        if (this.offTrack) this.speed *= (1 - dt * 2.0);
        if (this.oilTimer > 0) this.oilTimer -= dt;

        // Low grip + high speed + sharp steering = a moment.
        const steerLoad = Math.abs(steer) * (this.speed / Math.max(1, baseMaxSpeed));
        const slipLimit = 0.80 * grip;
        if (!this.inPitLane && steerLoad > slipLimit && this.speed > 170) {
            const risk = (steerLoad - slipLimit) * this.profile.risk * dt * 0.10;
            if (ctx.rng && ctx.rng.next() < risk) {
                this.triggerSpin(Math.min(1, steerLoad), 'lost the back end', ctx);
            }
        }

        const steerFactor = steerRate * (1 - (this.speed / baseMaxSpeed) * 0.35) * (0.75 + 0.25 * grip);
        this.angle += steer * steerFactor * dt;

        this.x += Math.cos(this.angle) * this.speed * dt;
        this.y += Math.sin(this.angle) * this.speed * dt;

        // Hard boundary — wider while in the pit lane so the lane is reachable.
        const cl = Track.closestPointNear(this.x, this.y, this.trackIndex);
        const maxDist = this.inPitLane
            ? Track.getWidth() / 2 + 12 + Track.getPitLaneWidth()
            : Track.getWidth() * 0.52;
        if (cl.dist > maxDist) {
            const ccp = Track.getPoints()[cl.index];
            const dx = this.x - ccp.x, dy = this.y - ccp.y;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d > 0) {
                this.x = ccp.x + (dx / d) * maxDist;
                this.y = ccp.y + (dy / d) * maxDist;
            }
            this.speed *= 0.92;
        }
    }

    // -------------------------------------------------------------------------
    // Incidents
    // -------------------------------------------------------------------------

    triggerSpin(severity, cause, ctx) {
        if (this.spinTimer > 0 || this.retired) return;
        this.spinTimer = 0.9 + severity * 0.9;
        this.spinRate = (ctx.rng && ctx.rng.chance(0.5) ? 1 : -1) * (5 + severity * 6);
        this.speed *= 0.45;
        this.spins++;
        this.addDamage(severity * 0.045, ctx);
        if (ctx.events) ctx.events.add(ctx.simTime, 'spin', {
            carId: this.id, name: this.name, speechName: this.speechName, team: this.team,
            position: this.position, severity, cause,
        });
        if (typeof Effects !== 'undefined' && ctx.effects !== false) {
            Effects.addTireSmoke(this.x, this.y, this.angle, 1);
            Effects.addSparks(this.x, this.y, 10);
        }
    }

    addDamage(amount, ctx) {
        const scaled = amount * (1 + this.mods.damage);
        this.damage = Math.min(1.2, this.damage + Math.max(0, scaled));
        if (this.damage >= 1.0 && !this.retired) this.retire('terminal damage', ctx);
    }

    retire(reason, ctx) {
        if (this.retired) return;
        this.retired = true;
        this.dnfReason = reason;
        this._retireTime = ctx ? ctx.simTime : 0;
        this.drsActive = false;
        this.inPitLane = false;
        this.pitState = 'none';
        if (ctx && ctx.events) ctx.events.add(ctx.simTime, 'dnf', {
            carId: this.id, name: this.name, speechName: this.speechName, team: this.team,
            position: this.position, reason, lap: this.lap + 1,
        });
    }

    activateBoost(duration) {
        this.boostTimer = Math.max(this.boostTimer, duration);
        if (typeof Effects !== 'undefined') Effects.addSparks(this.x, this.y, 6);
    }

    activateOilSlick(ctx) {
        if (this.oilTimer > 0) return;
        this.oilTimer = 1.8;
        this.speed *= 0.55;
        if (typeof Effects !== 'undefined') Effects.addSparks(this.x, this.y, 10);
    }

    // -------------------------------------------------------------------------
    // Collisions
    // -------------------------------------------------------------------------

    resolveCollisions(ctx) {
        if (this.pitState === 'stopped') return;
        for (const other of ctx.cars) {
            if (other === this || other.retired) continue;
            // Cars in the pit lane cannot touch cars on the circuit.
            if (other.inPitLane !== this.inPitLane) continue;
            if (other.pitState === 'stopped') continue;

            const dx = other.x - this.x, dy = other.y - this.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const minDist = this.collisionRadius + other.collisionRadius;
            if (dist >= minDist || dist < 0.01) continue;

            const overlap = minDist - dist;
            const nx = dx / dist, ny = dy / dist;
            const push = overlap * 0.6;
            this.x -= nx * push; this.y -= ny * push;
            other.x += nx * push; other.y += ny * push;

            const isTeam = other.team === this.team;
            const keep = isTeam ? 0.97 : 0.92;
            const xfer = isTeam ? 0.02 : 0.05;
            const mySpd = this.speed, thSpd = other.speed;
            this.speed = mySpd * keep + thSpd * xfer;
            other.speed = thSpd * keep + mySpd * xfer;

            const deflect = isTeam ? 0.02 : 0.04;
            this.angle -= nx * deflect;
            other.angle += nx * deflect;

            // Only count a real *impact*: closing speed, not a gentle rub.
            const closing = Math.abs(mySpd - thSpd) + overlap * 6;
            if (!isTeam && closing > 95) {
                this.contacts++;
                const sev = Math.min(1, (closing - 95) / 240);
                this.addDamage(sev * 0.085, ctx);
                other.addDamage(sev * 0.060, ctx);
                if (ctx.events && sev > 0.30 && !this._contactCooldown) {
                    this._contactCooldown = 2.5;
                    ctx.events.add(ctx.simTime, sev > 0.55 ? 'crash' : 'contact', {
                        carId: this.id, name: this.name, speechName: this.speechName, team: this.team,
                        otherId: other.id, otherName: other.name, otherSpeech: other.speechName,
                        position: Math.min(this.position, other.position), severity: sev,
                    });
                }
                if (sev > 0.72 && ctx.rng && ctx.rng.chance(0.22)) this.triggerSpin(sev, 'contact', ctx);
            }
            if (typeof Effects !== 'undefined' && !isTeam && ctx.effects !== false) {
                Effects.addSparks((this.x + other.x) / 2, (this.y + other.y) / 2, 4);
            }
        }
    }

    // -------------------------------------------------------------------------
    // Housekeeping
    // -------------------------------------------------------------------------

    detectStuck(dt) {
        if (this._contactCooldown > 0) this._contactCooldown = Math.max(0, this._contactCooldown - dt);
        if (this.pitState === 'stopped' || this.retired) { this.stuckTimer = 0; return; }

        const idxDiff = Math.abs(this.trackIndex - this.lastTrackIdx);
        if (idxDiff < 2 && this.speed < 10 && this.spinTimer <= 0) {
            this.stuckTimer += dt;
            if (this.stuckTimer > 1.2) {
                const tn = Track.getPointCount();
                const ni = (this.trackIndex + 5) % tn;
                const pos = Track.getPositionAt(ni / tn, this.inPitLane ? Track.getPit().offset : this.targetLane * 20);
                this.x = pos.x; this.y = pos.y; this.angle = pos.angle;
                this.speed = 80;
                this.stuckTimer = 0;
            }
        } else {
            this.stuckTimer = 0;
        }
        this.lastTrackIdx = this.trackIndex;
    }

    updateProgress(ctx) {
        const tn = Track.getPointCount();
        const newProg = this.trackIndex / tn;

        // Sector splits
        const sectors = Track.getSectors();
        for (let s = 0; s < sectors.length; s++) {
            if (_crossedMark(this.progress, newProg, sectors[s])) {
                const t = ctx.simTime - this._sectorStart;
                if (this._sectorStart > 0 && t > 500) this.sectorTimes[(s + 2) % 3] = t;
                this._sectorStart = ctx.simTime;
            }
        }

        const delta = newProg - this.progress;

        // Crossed the line backwards (spun on the straight): undo the lap.
        if (delta > 0.5) {
            this.lap--;
            this._lapTimingArmed = false;
        } else if (delta < -0.5) {
            this.lap++;
            const lapTime = ctx.simTime - this.lapStartTime;
            const covered = (this.lap + newProg) - (this._lapStartTotal !== undefined ? this._lapStartTotal : Infinity);
            // A lap only counts once the car has crossed the line at least
            // once (grid cars start a few metres short of it) and only if it
            // really went the long way round.
            if (this._lapTimingArmed && lapTime > 1500 && covered > 0.85) {
                this.lastLapTime = lapTime;
                this.lapTimes.push(lapTime);
                if (lapTime < this.bestLapTime) {
                    this.bestLapTime = lapTime;
                    this._newPersonalBest = true;
                }
            }
            this._lapTimingArmed = true;
            this.lapStartTime = ctx.simTime;
            this._lapStartTotal = this.lap + newProg;
            this._crossedLine = true;
        }
        this.prevProgress = this.progress;
        this.progress = newProg;
        this.totalProgress = this.lap + this.progress;
        this.currentLapTime = ctx.simTime - this.lapStartTime;
    }

    // -------------------------------------------------------------------------
    // Effects & drawing
    // -------------------------------------------------------------------------

    emitEffects(ctx) {
        if (this._finishedRace || this.retired || typeof Effects === 'undefined') return;
        const wet = ctx.weather ? ctx.weather.state.wetness : 0;

        const brakeAmt = this.brakeAmount || 0;
        if (this.braking && brakeAmt > 0.35 && this.speed > 60 && !this.inPitLane) {
            Effects.addSkidMark(this.x, this.y, this.angle, brakeAmt);
            if (brakeAmt > 0.62) Effects.addTireSmoke(this.x, this.y, this.angle, brakeAmt * 0.5);
        }
        if (wet > 0.15 && this.speed > 90) Effects.addSpray(this.x, this.y, this.angle, wet);
        if (this.slipstreaming && this.speed > 100) Effects.addSlipstreamLines(this.x, this.y, this.angle);
        if (this.offTrack && this.speed > 30) Effects.addDirt(this.x, this.y, this.angle);
        if (this.boostTimer > 0) Effects.addTireSmoke(this.x, this.y, this.angle + Math.PI, 0.25);
        if (this.spinTimer > 0) Effects.addTireSmoke(this.x, this.y, this.angle, 0.8);
        if (this.damage > 0.4) Effects.addSmokeTrail(this.x, this.y, this.damage);
    }

    draw(ctx) {
        if (!this.image || !this.image.complete) return;
        if (this._finishAlpha <= 0.01) return;

        ctx.save();
        if (this._finishAlpha < 1) ctx.globalAlpha = this._finishAlpha;
        ctx.translate(this.x, this.y);
        ctx.rotate(this.angle);

        // Rainbow outline for the race leader
        if (this.position === 1 && !this.retired) {
            const now = Date.now();
            ctx.save();
            ctx.lineWidth = 2.8;
            ctx.lineCap = 'round';
            const hw = 30, hh = 17, cr = 5;
            const N = 48;
            for (let i = 0; i < N; i++) {
                const p0 = _carPerimPt(i / N, hw, hh, cr);
                const p1 = _carPerimPt((i + 1) / N, hw, hh, cr);
                const hue = ((now * 0.09 + (i / N) * 360) % 360 + 360) % 360;
                ctx.strokeStyle = `hsl(${hue}, 100%, 62%)`;
                ctx.shadowColor = `hsl(${hue}, 100%, 72%)`;
                ctx.shadowBlur = 7;
                ctx.globalAlpha = 0.92;
                ctx.beginPath();
                ctx.moveTo(p0.x, p0.y);
                ctx.lineTo(p1.x, p1.y);
                ctx.stroke();
            }
            ctx.restore();
        }

        // DRS open — a cyan flare off the rear wing
        if (this.drsActive) {
            ctx.save();
            ctx.globalAlpha = 0.75;
            ctx.strokeStyle = '#4fe3ff';
            ctx.shadowColor = '#4fe3ff';
            ctx.shadowBlur = 12;
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(-24, -11); ctx.lineTo(-24, 11);
            ctx.stroke();
            ctx.restore();
        }

        if (this.boostTimer > 0) {
            ctx.save();
            ctx.globalAlpha = 0.45;
            ctx.shadowColor = '#FFD700';
            ctx.shadowBlur = 18;
            ctx.beginPath();
            ctx.ellipse(0, 0, 26, 14, 0, 0, Math.PI * 2);
            ctx.fillStyle = '#FFD70033';
            ctx.fill();
            ctx.restore();
        }

        // Shadow
        ctx.save();
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.ellipse(2, 2, 22, 11, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        const w = 52, h = 28;
        ctx.drawImage(this.image, -w / 2, -h / 2, w, h);

        // Tyre colour flashes on the wheels
        const tc = this.tyre.color;
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = tc;
        ctx.fillRect(-8, -h / 2 + 0.5, 8, 2);
        ctx.fillRect(-8, h / 2 - 2.5, 8, 2);
        ctx.globalAlpha = 1;

        if (this.braking) {
            ctx.fillStyle = 'rgba(255,0,0,0.85)';
            ctx.fillRect(-w / 2 - 1, -5, 3, 4);
            ctx.fillRect(-w / 2 - 1, 2, 3, 4);
        }

        ctx.restore();

        // Position badge — drawn unrotated so it stays readable
        if (!this.retired) {
            ctx.save();
            if (this._finishAlpha < 1) ctx.globalAlpha = this._finishAlpha;
            ctx.translate(this.x, this.y - 24);
            ctx.fillStyle = 'rgba(0,0,0,0.65)';
            ctx.fillRect(-9, -6, 18, 12);
            ctx.fillStyle = this.position === 1 ? '#FFD700' : '#fff';
            ctx.font = 'bold 10px Arial';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(`P${this.position}`, 0, 0);
            ctx.restore();
        }
    }
}
