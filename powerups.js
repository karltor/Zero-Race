/**
 * PowerUps — the arcade layer that keeps the pack together.
 *
 * Boost pads only light up in the "racing zone" (the stretch of track that
 * still has cars on it) and the leader can never take one, so they work as a
 * pure catch-up mechanic rather than a runaway multiplier.
 *
 * Instance-based: `PowerUps.create(rng)`. Each race gets its own instance fed
 * by the seeded stream so pad states and oil spawns replay identically.
 */
const PowerUps = (() => {

    const NUM_BOOST_PADS = 8;
    const BOOST_PAD_RADIUS = 22;
    const PAD_COOLDOWN = 14.0;
    const OIL_LIFE = 9.0;
    const OIL_SPAWN_MIN = 18;
    const OIL_SPAWN_MAX = 30;
    const PAD_LANE_OFFSETS = [0, 18, -18, 24, -24, 12, -12, 0];

    function create(rng) {
        const boostPads = [];
        const oilSlicks = [];
        let oilSpawnTimer = 0;
        const R = rng || Rng.create(7);

        function init() {
            boostPads.length = 0;
            oilSlicks.length = 0;

            const pointCount = Track.getPointCount();
            for (let i = 0; i < NUM_BOOST_PADS; i++) {
                // Skip the pit straight — a boost pad in the pit lane entry is chaos.
                const progress = 0.10 + (i / NUM_BOOST_PADS) * 0.86;
                const laneOffset = PAD_LANE_OFFSETS[i] || 0;
                const pos = Track.getPositionAt(progress, laneOffset);
                const idx = Math.floor(progress * pointCount);
                boostPads.push({
                    x: pos.x, y: pos.y, angle: Track.angleAt(idx),
                    active: true, cooldownTimer: 0,
                    trackProgress: progress,
                    leaderPassed: false,
                    unlockThreshold: -1,
                    inDeadZone: false,
                });
            }
            oilSpawnTimer = OIL_SPAWN_MIN + R.next() * (OIL_SPAWN_MAX - OIL_SPAWN_MIN);
        }

        /** True when padFrac sits in the empty stretch running forward from the leader to the last car. */
        function _isInDeadZone(padFrac, leaderFrac, lastFrac) {
            if (leaderFrac <= lastFrac) return padFrac >= leaderFrac && padFrac <= lastFrac;
            return padFrac >= leaderFrac || padFrac <= lastFrac;
        }

        function update(dt, ctx) {
            const cars = ctx.cars.filter(c => !c.retired);
            _updateBoostPads(dt, cars, ctx);
            _updateOilSlicks(dt, cars, ctx);
            _spawnOilSlick(dt, cars, ctx);
            _applyCatchup(ctx.cars);
        }

        function _updateBoostPads(dt, cars, ctx) {
            const leader = ctx.leader;
            if (!leader || !cars.length) return;
            const scActive = !!(ctx.safetyCar && ctx.safetyCar.active);

            const leaderTotal = leader.totalProgress;
            const leaderFrac = leaderTotal % 1;
            const leaderLaps = Math.floor(leaderTotal);

            let lastCar = cars[0];
            for (const c of cars) if (c.totalProgress < lastCar.totalProgress) lastCar = c;
            const lastFrac = lastCar.progress;

            for (const pad of boostPads) {
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

                if (!pad.active) {
                    pad.cooldownTimer -= dt;
                    if (pad.cooldownTimer <= 0) { pad.active = true; pad.cooldownTimer = 0; }
                    pad.inDeadZone = false;
                    continue;
                }

                pad.inDeadZone = _isInDeadZone(pad.trackProgress, leaderFrac, lastFrac);
                if (pad.inDeadZone || scActive) continue;

                for (const car of cars) {
                    if (car === leader || car.inPitLane || car.retired) continue;
                    const dx = car.x - pad.x, dy = car.y - pad.y;
                    if (dx * dx + dy * dy > BOOST_PAD_RADIUS * BOOST_PAD_RADIUS) continue;

                    const gap = Math.max(0, leader.totalProgress - car.totalProgress);
                    car.boostTimer = Math.max(car.boostTimer, Math.min(7.0, 2.0 + gap * 5.5));
                    car.boostersCollected = (car.boostersCollected || 0) + 1;
                    if (typeof Effects !== 'undefined' && ctx.effects !== false) Effects.addSparks(car.x, car.y, 8);
                    pad.active = false;
                    pad.cooldownTimer = PAD_COOLDOWN;
                    break;
                }
            }
        }

        function _updateOilSlicks(dt, cars, ctx) {
            for (let i = oilSlicks.length - 1; i >= 0; i--) {
                const oil = oilSlicks[i];
                oil.life -= dt;
                if (oil.life <= 0) { oilSlicks.splice(i, 1); continue; }

                for (const car of cars) {
                    if (car.inPitLane) continue;
                    const dx = car.x - oil.x, dy = car.y - oil.y;
                    if (dx * dx + dy * dy >= oil.radius * oil.radius) continue;
                    if (car.oilTimer > 0) continue;

                    car.activateOilSlick(ctx);
                    // Hit oil at speed with cold or worn tyres and you are a passenger.
                    const spinRisk = 0.04 + car.tyreWear * 0.10 + Math.max(0, car.speed - 200) / 900;
                    if (ctx.rng && ctx.rng.chance(spinRisk * car.profile.risk)) {
                        car.triggerSpin(0.5 + car.speed / 700, 'oil on the racing line', ctx);
                    }
                }
            }
        }

        function _spawnOilSlick(dt, cars, ctx) {
            oilSpawnTimer -= dt;
            if (oilSpawnTimer > 0) return;
            oilSpawnTimer = OIL_SPAWN_MIN + R.next() * (OIL_SPAWN_MAX - OIL_SPAWN_MIN);
            if (ctx.safetyCar && ctx.safetyCar.active) return;

            const leaders = cars.filter(c => c.position >= 1 && c.position <= 3 && !c.inPitLane);
            if (!leaders.length) return;

            const target = leaders[Math.floor(R.next() * leaders.length)];
            const offsetDist = 30 + R.next() * 30;
            const angle = target.angle + Math.PI;
            oilSlicks.push({
                x: target.x + Math.cos(angle) * offsetDist,
                y: target.y + Math.sin(angle) * offsetDist,
                radius: 20 + R.next() * 15,
                life: OIL_LIFE,
            });
        }

        function _applyCatchup(cars) {
            for (const car of cars) {
                car.catchupFactor = car.position >= 5 ? 0.06 * (car.position - 4) : 0;
            }
        }

        // ── Drawing ──────────────────────────────────────────────────────────

        function draw(ctx2d) {
            _drawOilSlicks(ctx2d);
            _drawBoostPads(ctx2d);
        }

        function _drawOilSlicks(ctx2d) {
            for (const oil of oilSlicks) {
                const alpha = Math.min(1, oil.life / 3);
                ctx2d.save();
                ctx2d.globalAlpha = alpha * 0.82;
                ctx2d.translate(oil.x, oil.y);
                ctx2d.scale(1.0, 0.6);
                const grad = ctx2d.createRadialGradient(0, 0, 0, 0, 0, oil.radius);
                grad.addColorStop(0, 'rgba(60, 0, 80, 0.95)');
                grad.addColorStop(0.3, 'rgba(0, 60, 40, 0.85)');
                grad.addColorStop(0.6, 'rgba(40, 0, 60, 0.70)');
                grad.addColorStop(0.85, 'rgba(0, 40, 50, 0.45)');
                grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
                ctx2d.beginPath();
                ctx2d.arc(0, 0, oil.radius, 0, Math.PI * 2);
                ctx2d.fillStyle = grad;
                ctx2d.fill();
                ctx2d.restore();
            }
        }

        function _arrowPath(ctx2d) {
            ctx2d.beginPath();
            ctx2d.moveTo(14, 0);
            ctx2d.lineTo(2, 10);
            ctx2d.lineTo(2, 5);
            ctx2d.lineTo(-14, 5);
            ctx2d.lineTo(-14, -5);
            ctx2d.lineTo(2, -5);
            ctx2d.lineTo(2, -10);
            ctx2d.closePath();
        }

        function _drawBoostPads(ctx2d) {
            const now = Date.now();
            for (const pad of boostPads) {
                if (!pad.leaderPassed || !pad.active) continue;

                ctx2d.save();
                ctx2d.translate(pad.x, pad.y);
                ctx2d.rotate(pad.angle);

                if (pad.inDeadZone) {
                    ctx2d.globalAlpha = 0.30;
                    _arrowPath(ctx2d);
                    ctx2d.fillStyle = '#aaaaaa';
                    ctx2d.fill();
                    ctx2d.strokeStyle = '#cccccc';
                    ctx2d.lineWidth = 1;
                    ctx2d.stroke();
                    ctx2d.restore();
                    continue;
                }

                const pulse = 0.5 + 0.5 * Math.sin(now * 0.004 + pad.x * 0.01);
                const glowRadius = 18 + pulse * 12;
                const baseAlpha = 0.55 + pulse * 0.45;

                const halo = ctx2d.createRadialGradient(0, 0, 2, 0, 0, glowRadius);
                halo.addColorStop(0, `rgba(255, 220, 40, ${(baseAlpha * 0.6).toFixed(3)})`);
                halo.addColorStop(0.5, `rgba(255, 180, 0,  ${(baseAlpha * 0.25).toFixed(3)})`);
                halo.addColorStop(1, 'rgba(255, 160, 0, 0)');
                ctx2d.beginPath();
                ctx2d.arc(0, 0, glowRadius, 0, Math.PI * 2);
                ctx2d.fillStyle = halo;
                ctx2d.fill();

                ctx2d.globalAlpha = baseAlpha;
                ctx2d.shadowColor = '#ffd700';
                ctx2d.shadowBlur = 8 + pulse * 8;
                _arrowPath(ctx2d);
                ctx2d.fillStyle = '#ffd700';
                ctx2d.fill();

                ctx2d.globalAlpha = baseAlpha * 0.5;
                ctx2d.strokeStyle = '#fff8aa';
                ctx2d.lineWidth = 1.5;
                ctx2d.stroke();

                ctx2d.restore();
            }
        }

        return { init, update, draw, boostPads, oilSlicks };
    }

    return { create };
})();
