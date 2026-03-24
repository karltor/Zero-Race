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
                cooldownTimer: 0
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
    function update(dt, cars) {
        _updateBoostPads(dt, cars);
        _updateOilSlicks(dt, cars);
        _spawnOilSlick(dt, cars);
        _applyCatchup(cars);
    }

    /** Tick pad cooldowns and test car overlaps. */
    function _updateBoostPads(dt, cars) {
        for (const pad of boostPads) {
            if (!pad.active) {
                pad.cooldownTimer -= dt;
                if (pad.cooldownTimer <= 0) {
                    pad.active = true;
                    pad.cooldownTimer = 0;
                }
                // No collision while cooling down.
                continue;
            }

            // Check whether any car is close enough to trigger the pad.
            for (const car of cars) {
                const dx = car.x - pad.x;
                const dy = car.y - pad.y;
                if (dx * dx + dy * dy <= BOOST_PAD_RADIUS * BOOST_PAD_RADIUS) {
                    // Backmarkers get a longer boost — position 1 gets 3.0 s, P8 gets ~5.1 s.
                    car.boostTimer = 3.0 + (car.position - 1) * 0.3;

                    pad.active = false;
                    pad.cooldownTimer = PAD_COOLDOWN;
                    break; // One car per frame is enough; pad is now inactive.
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

    /**
     * Draw glowing golden arrow boost pads with a pulsing animation.
     * Only active pads are drawn.
     */
    function _drawBoostPads(ctx) {
        const now = Date.now();

        for (const pad of boostPads) {
            if (!pad.active) continue;

            // Pulse: oscillate glow intensity and slight scale using a sine wave.
            const pulse = 0.5 + 0.5 * Math.sin(now * 0.004 + pad.x * 0.01);
            const glowRadius = 18 + pulse * 12;
            const baseAlpha  = 0.55 + pulse * 0.45;

            ctx.save();
            ctx.translate(pad.x, pad.y);
            ctx.rotate(pad.angle);

            // --- Outer glow halo ---
            const halo = ctx.createRadialGradient(0, 0, 2, 0, 0, glowRadius);
            halo.addColorStop(0,   `rgba(255, 220, 40, ${(baseAlpha * 0.6).toFixed(3)})`);
            halo.addColorStop(0.5, `rgba(255, 180, 0,  ${(baseAlpha * 0.25).toFixed(3)})`);
            halo.addColorStop(1,   'rgba(255, 160, 0, 0)');

            ctx.beginPath();
            ctx.arc(0, 0, glowRadius, 0, Math.PI * 2);
            ctx.fillStyle = halo;
            ctx.fill();

            // --- Arrow body ---
            // The arrow points in the direction of track travel (+x after rotation).
            ctx.globalAlpha = baseAlpha;
            ctx.shadowColor  = '#ffd700';
            ctx.shadowBlur   = 8 + pulse * 8;

            ctx.beginPath();
            // Arrowhead tip at front (+x), tail at back (-x).
            // Body: a chevron / arrow shape.
            const tipX   =  14;
            const tailX  = -14;
            const bodyW  =  5;   // half-height of shaft
            const headW  =  10;  // half-height of arrowhead base
            const neckX  =  2;   // x position where shaft meets arrowhead base

            ctx.moveTo(tipX,   0);          // tip
            ctx.lineTo(neckX,  headW);      // right side of head
            ctx.lineTo(neckX,  bodyW);      // step inward to shaft
            ctx.lineTo(tailX,  bodyW);      // back right of shaft
            ctx.lineTo(tailX, -bodyW);      // back left of shaft
            ctx.lineTo(neckX, -bodyW);      // step inward to shaft (left)
            ctx.lineTo(neckX, -headW);      // left side of head
            ctx.closePath();

            ctx.fillStyle = '#ffd700';
            ctx.fill();

            // Inner highlight stripe for depth.
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
