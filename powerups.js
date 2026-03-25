/**
 * PowerUps - Mario Kart-style catch-up mechanics for the top-down 2D racing game.
 * Provides: boost pads (golden speed-up arrows), oil slicks (iridescent hazard patches),
 * and a passive catch-up factor applied to backmarkers.
 *
 * Depends on globals: Track, Effects, and Car objects with x/y/angle/speed/position/team.
 */
const PowerUps = (() => {

    // -------------------------------------------------------------------------
    // Internal state
    // -------------------------------------------------------------------------

    /** @type {Array<{x:number, y:number, angle:number, active:boolean, cooldownTimer:number}>} */
    const boostPads = [];

    /** @type {Array<{x:number, y:number, radius:number, life:number}>} */
    const oilSlicks = [];

    /** Seconds until the next oil slick is spawned. */
    let oilSpawnTimer = 0;

    // How often (seconds) between oil slick spawns — randomised each time.
    const OIL_SPAWN_MIN = 12;
    const OIL_SPAWN_MAX = 20;

    /** Number of evenly-spaced boost pads placed around the track. */
    const NUM_BOOST_PADS = 8;

    /** Trigger radius (px) for a car to hit a boost pad. */
    const BOOST_PAD_RADIUS = 22;

    /** How long (seconds) a pad is inactive after being triggered. */
    const PAD_COOLDOWN = 10.0;

    /** How long (seconds) the oil slick persists before fading away. */
    const OIL_LIFE = 15.0;

    // Slight lateral offsets applied to alternate pads so they aren't all on the centre line.
    const PAD_LANE_OFFSETS = [0, 18, -18, 24, -24, 12, -12, 0];

    // -------------------------------------------------------------------------
    // init
    // -------------------------------------------------------------------------

    /**
     * Place boost pads evenly around the track and reset all oil slick state.
     * Reads Track directly — takes no arguments.
     */
    function init() {
        boostPads.length = 0;
        oilSlicks.length = 0;

        const pointCount = Track.getPointCount();

        for (let i = 0; i < NUM_BOOST_PADS; i++) {
            const progress = i / NUM_BOOST_PADS;
            const laneOffset = PAD_LANE_OFFSETS[i] || 0;

            const pos = Track.getPositionAt(progress, laneOffset);
            const idx = Math.floor(progress * pointCount);
            const angle = Track.angleAt(idx);

            boostPads.push({
                x: pos.x,
                y: pos.y,
                angle: angle,
                active: true,
                cooldownTimer: 0,
                trackProgress: progress,    // fractional position around track (0-1)
                leaderPassed: false,        // becomes true once P1 has driven past this point
                unlockThreshold: -1         // computed on first update; leader.totalProgress must reach this
            });
        }

        // First oil slick spawn is randomised.
        oilSpawnTimer = OIL_SPAWN_MIN + Math.random() * (OIL_SPAWN_MAX - OIL_SPAWN_MIN);
    }

    // -------------------------------------------------------------------------
    // update
    // -------------------------------------------------------------------------

    /**
     * Advance all power-up timers, check collisions, and apply passive catch-up.
     * @param {number} dt   Delta time in seconds.
     * @param {Car[]}  cars Array of Car objects.
     */
    function update(dt, cars, leader) {
        _updateBoostPads(dt, cars, leader);
        _updateOilSlicks(dt, cars);
        _spawnOilSlick(dt, cars);
        _applyCatchup(cars);
    }

    /** Returns true if padFrac is in the "dead zone" — the empty stretch of track
     *  going FORWARD from the leader to the last car, where boosts are allowed.
     *  The "racing zone" (from last car forward to leader, where all cars are)
     *  is boost-free.
     */
    function _isInDeadZone(padFrac, leaderFrac, lastFrac) {
        // Dead zone: leaderFrac → (forward) → lastFrac
        if (leaderFrac <= lastFrac) {
            // No wrap: dead zone is [leaderFrac, lastFrac]
            return padFrac >= leaderFrac && padFrac <= lastFrac;
        } else {
            // Wraps around 0/1: dead zone is [leaderFrac, 1) ∪ [0, lastFrac]
            return padFrac >= leaderFrac || padFrac <= lastFrac;
        }
    }

    /** Tick pad cooldowns and test car overlaps.
     *  Pads are only visible (golden) and collectable inside the "dead zone" —
     *  the empty stretch of track from the leader forward to the last car.
     *  Pads in the racing zone (between last car and leader) are greyed out.
     *  The race leader can never collect a boost under any circumstances.
     */
    function _updateBoostPads(dt, cars, leader) {
        if (!leader) return;

        const leaderTotal = leader.totalProgress;
        const leaderFrac  = leaderTotal % 1;
        const leaderLaps  = Math.floor(leaderTotal);

        // Find the car furthest behind (lowest totalProgress)
        let lastCar = cars[0];
        for (const c of cars) {
            if (c.totalProgress < lastCar.totalProgress) lastCar = c;
        }
        const lastFrac = lastCar.progress; // fractional position 0–1

        for (const pad of boostPads) {
            // ── Initial unlock: wait until leader physically passes this point ──
            if (!pad.leaderPassed) {
                if (pad.unlockThreshold < 0) {
                    pad.unlockThreshold = leaderFrac > pad.trackProgress
                        ? leaderLaps + 1 + pad.trackProgress
                        : leaderLaps + pad.trackProgress;
                }
                if (leaderTotal >= pad.unlockThreshold) pad.leaderPassed = true;
                pad.inDeadZone = false;
                continue;
            }

            // ── Cooldown after being collected ──
            if (!pad.active) {
                pad.cooldownTimer -= dt;
                if (pad.cooldownTimer <= 0) { pad.active = true; pad.cooldownTimer = 0; }
                pad.inDeadZone = false;
                continue;
            }

            // ── Dead-zone check: is this pad in the empty part of the track? ──
            pad.inDeadZone = _isInDeadZone(pad.trackProgress, leaderFrac, lastFrac);

            // Pads in the dead zone (empty track) are greyed out — no cars to collect them
            if (pad.inDeadZone) continue;

            // ── Collision — leader is explicitly excluded ──
            for (const car of cars) {
                if (car === leader) continue; // leader can NEVER collect a boost
                const dx = car.x - pad.x, dy = car.y - pad.y;
                if (dx * dx + dy * dy <= BOOST_PAD_RADIUS * BOOST_PAD_RADIUS) {
                    const gap = Math.max(0, leader.totalProgress - car.totalProgress);
                    car.boostTimer = Math.max(car.boostTimer, Math.min(7.0, 2.0 + gap * 5.5));
                    Effects.addSparks(car.x, car.y, 8);
                    pad.active = false;
                    pad.cooldownTimer = PAD_COOLDOWN;
                    break;
                }
            }
        }
    }

    /** Fade oil slick lifetimes, test car overlaps, apply spin-out effect. */
    function _updateOilSlicks(dt, cars) {
        for (let i = oilSlicks.length - 1; i >= 0; i--) {
            const oil = oilSlicks[i];
            oil.life -= dt;

            if (oil.life <= 0) {
                oilSlicks.splice(i, 1);
                continue;
            }

            for (const car of cars) {
                const dx = car.x - oil.x;
                const dy = car.y - oil.y;
                const dist = Math.sqrt(dx * dx + dy * dy);

                if (dist < oil.radius) {
                    // Only apply the spin-out effect if the car isn't already spinning.
                    if (!car.oilTimer || car.oilTimer <= 0) {
                        car.oilTimer = 1.8;
                        car.speed *= 0.55;
                        Effects.addSparks(car.x, car.y, 10);
                    }
                }
            }
        }
    }

    /**
     * Count down the spawn timer. When it fires, drop a new oil slick near one
     * of the top-3 cars (the leaders) and randomise the next interval.
     */
    function _spawnOilSlick(dt, cars) {
        oilSpawnTimer -= dt;
        if (oilSpawnTimer > 0) return;

        // Reset timer for next spawn.
        oilSpawnTimer = OIL_SPAWN_MIN + Math.random() * (OIL_SPAWN_MAX - OIL_SPAWN_MIN);

        // Collect cars in positions 1–3.
        const leaders = cars.filter(c => c.position >= 1 && c.position <= 3);
        if (leaders.length === 0) return;

        // Pick one at random.
        const target = leaders[Math.floor(Math.random() * leaders.length)];

        // Place the slick slightly behind the car so it doesn't instantly hit them.
        const offsetDist = 30 + Math.random() * 30;
        const angle = target.angle + Math.PI; // behind
        const ox = target.x + Math.cos(angle) * offsetDist;
        const oy = target.y + Math.sin(angle) * offsetDist;

        oilSlicks.push({
            x: ox,
            y: oy,
            radius: 20 + Math.random() * 15, // 20–35 px
            life: OIL_LIFE
        });
    }

    /**
     * Apply passive catch-up factor to each car based on their current position.
     * Cars in P5–P8 receive a positive catchupFactor; P1–P4 receive zero.
     * The AI / physics layer reads car.catchupFactor to adjust top speed.
     */
    function _applyCatchup(cars) {
        for (const car of cars) {
            if (car.position >= 5) {
                // P5 → 0.06, P6 → 0.12, P7 → 0.18, P8 → 0.24
                car.catchupFactor = 0.06 * (car.position - 4);
            } else {
                car.catchupFactor = 0;
            }
        }
    }

    // -------------------------------------------------------------------------
    // draw
    // -------------------------------------------------------------------------

    /**
     * Draw all power-up visuals.
     *
     * Oil slicks must be drawn BEFORE the cars (call this before drawing cars).
     * Boost pads may be drawn on top.
     *
     * @param {CanvasRenderingContext2D} ctx
     */
    function draw(ctx) {
        _drawOilSlicks(ctx);
        _drawBoostPads(ctx);
    }

    /** Draw iridescent dark oil patches; alpha fades as life decreases. */
    function _drawOilSlicks(ctx) {
        for (const oil of oilSlicks) {
            // Fade out during the last 3 seconds of life.
            const alpha = Math.min(1, oil.life / 3);

            ctx.save();
            ctx.globalAlpha = alpha * 0.82;

            // Slightly squash the circle into an oval oriented along the track.
            ctx.translate(oil.x, oil.y);
            ctx.scale(1.0, 0.6);

            const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, oil.radius);
            grad.addColorStop(0,   'rgba(60, 0, 80, 0.95)');    // deep purple centre
            grad.addColorStop(0.3, 'rgba(0, 60, 40, 0.85)');    // dark green shimmer
            grad.addColorStop(0.6, 'rgba(40, 0, 60, 0.70)');    // purple mid
            grad.addColorStop(0.85,'rgba(0, 40, 50, 0.45)');    // teal edge
            grad.addColorStop(1,   'rgba(0, 0, 0, 0)');         // transparent rim

            ctx.beginPath();
            ctx.arc(0, 0, oil.radius, 0, Math.PI * 2);
            ctx.fillStyle = grad;
            ctx.fill();

            ctx.restore();
        }
    }

    /** Shared arrow path — call after translate/rotate. */
    function _arrowPath(ctx) {
        ctx.beginPath();
        ctx.moveTo( 14,   0);
        ctx.lineTo(  2,  10);
        ctx.lineTo(  2,   5);
        ctx.lineTo(-14,   5);
        ctx.lineTo(-14,  -5);
        ctx.lineTo(  2,  -5);
        ctx.lineTo(  2, -10);
        ctx.closePath();
    }

    /**
     * Draw boost pads.
     * - Golden + glowing  → in the dead zone (collectable by non-leader cars)
     * - Grey + dim        → in the racing zone (not collectable, just visible)
     */
    function _drawBoostPads(ctx) {
        const now = Date.now();

        for (const pad of boostPads) {
            if (!pad.leaderPassed || !pad.active) continue;

            ctx.save();
            ctx.translate(pad.x, pad.y);
            ctx.rotate(pad.angle);

            if (pad.inDeadZone) {
                // ── Grey / dormant — in the empty dead zone, no cars here ──
                ctx.globalAlpha = 0.30;
                _arrowPath(ctx);
                ctx.fillStyle = '#aaaaaa';
                ctx.fill();
                ctx.strokeStyle = '#cccccc';
                ctx.lineWidth = 1;
                ctx.stroke();
                ctx.restore();
                continue;
            }

            // ── Golden / active — in the racing zone where chasing cars are ──
            const pulse = 0.5 + 0.5 * Math.sin(now * 0.004 + pad.x * 0.01);
            const glowRadius = 18 + pulse * 12;
            const baseAlpha  = 0.55 + pulse * 0.45;

            // Outer glow halo
            const halo = ctx.createRadialGradient(0, 0, 2, 0, 0, glowRadius);
            halo.addColorStop(0,   `rgba(255, 220, 40, ${(baseAlpha * 0.6).toFixed(3)})`);
            halo.addColorStop(0.5, `rgba(255, 180, 0,  ${(baseAlpha * 0.25).toFixed(3)})`);
            halo.addColorStop(1,   'rgba(255, 160, 0, 0)');
            ctx.beginPath();
            ctx.arc(0, 0, glowRadius, 0, Math.PI * 2);
            ctx.fillStyle = halo;
            ctx.fill();

            // Arrow body
            ctx.globalAlpha = baseAlpha;
            ctx.shadowColor = '#ffd700';
            ctx.shadowBlur  = 8 + pulse * 8;
            _arrowPath(ctx);
            ctx.fillStyle = '#ffd700';
            ctx.fill();

            // Inner highlight
            ctx.globalAlpha = baseAlpha * 0.5;
            ctx.strokeStyle = '#fff8aa';
            ctx.lineWidth = 1.5;
            ctx.stroke();

            ctx.restore();
        }
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    return { init, update, draw };

})();
