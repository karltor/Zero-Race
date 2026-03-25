/**
 * Car with 2D physics and tactical AI.
 * Pure-pursuit steering eliminates "checkpoint" corner behavior.
 * Per-car racing line preferences create visible driving variety.
 */

/**
 * Returns a point on the perimeter of a rounded rectangle at fractional position t (0–1),
 * going clockwise from the top-left corner. hw/hh = half-width/height, cr = corner radius.
 */
function _carPerimPt(t, hw, hh, cr) {
    const sH = 2 * (hw - cr); // horizontal straight length
    const sV = 2 * (hh - cr); // vertical straight length
    const ca = (Math.PI / 2) * cr; // quarter-arc length
    const total = 2 * sH + 2 * sV + 4 * ca;
    let d = ((t % 1) + 1) % 1 * total;

    // TL corner (π → 3π/2)
    if (d < ca) { const a = Math.PI + (d / ca) * (Math.PI / 2); return { x: (-hw + cr) + cr * Math.cos(a), y: (-hh + cr) + cr * Math.sin(a) }; }
    d -= ca;
    // Top straight (left → right)
    if (d < sH) { return { x: -hw + cr + d, y: -hh }; }
    d -= sH;
    // TR corner (3π/2 → 2π)
    if (d < ca) { const a = 3 * Math.PI / 2 + (d / ca) * (Math.PI / 2); return { x: (hw - cr) + cr * Math.cos(a), y: (-hh + cr) + cr * Math.sin(a) }; }
    d -= ca;
    // Right straight (top → bottom)
    if (d < sV) { return { x: hw, y: -hh + cr + d }; }
    d -= sV;
    // BR corner (0 → π/2)
    if (d < ca) { const a = (d / ca) * (Math.PI / 2); return { x: (hw - cr) + cr * Math.cos(a), y: (hh - cr) + cr * Math.sin(a) }; }
    d -= ca;
    // Bottom straight (right → left)
    if (d < sH) { return { x: hw - cr - d, y: hh }; }
    d -= sH;
    // BL corner (π/2 → π)
    if (d < ca) { const a = Math.PI / 2 + (d / ca) * (Math.PI / 2); return { x: (-hw + cr) + cr * Math.cos(a), y: (hh - cr) + cr * Math.sin(a) }; }
    d -= ca;
    // Left straight (bottom → top)
    return { x: -hw, y: hh - cr - d };
}

const CAR_PROFILES = {
    1: { topSpeed: 1.03, accel: 1.00, braking: 1.00, cornering: 1.00, aggression: 0.50 },
    2: { topSpeed: 0.98, accel: 0.96, braking: 1.12, cornering: 1.05, aggression: 0.30 },
    3: { topSpeed: 1.08, accel: 1.04, braking: 0.92, cornering: 0.90, aggression: 0.60 },
    4: { topSpeed: 1.01, accel: 1.10, braking: 1.00, cornering: 0.96, aggression: 0.70 },
    5: { topSpeed: 0.97, accel: 0.96, braking: 1.04, cornering: 1.14, aggression: 0.40 },
    6: { topSpeed: 1.01, accel: 1.00, braking: 1.12, cornering: 0.98, aggression: 0.75 },
    7: { topSpeed: 1.00, accel: 1.02, braking: 1.02, cornering: 1.02, aggression: 0.35 },
    8: { topSpeed: 1.05, accel: 1.00, braking: 0.95, cornering: 0.96, aggression: 0.85 },
};

class Car {
    constructor(team, number) {
        this.team = team;
        this.number = number;
        this.name = `${team.charAt(0).toUpperCase() + team.slice(1)} #${number}`;
        this.image = CarSVG.getImage(team, number);

        const profile = CAR_PROFILES[number];
        this.stats = { ...profile };

        this.x = 0;
        this.y = 0;
        this.angle = 0;
        this.speed = 0;
        this.collisionRadius = 18;

        this.trackIndex = 0;
        this.progress = 0;
        this.lap = 0;
        this.totalProgress = 0;
        this.position = 0;
        this.lapStartTime = 0;
        this.bestLapTime = Infinity;
        this.currentLapTime = 0;
        this.lastLapTime = 0;
        this.lapTimes = [];

        // AI state
        this.targetLane = 0;
        this.overtakeTimer = 0;
        this.overtakeSide = 0;
        this.defendTimer = 0;
        this.blocked = false;
        this.braking = false;
        this.slipstreaming = false;
        this.offTrack = false;

        // Per-car racing line personality (set once, shapes style throughout the race)
        // apex: how tight they cut the inside; lineVariance: general lane bias
        this.apexCut = 0.35 + Math.random() * 0.45 * this.stats.cornering;
        this.lineVariance = (Math.random() - 0.5) * 0.22;

        // Power-up state (written by PowerUps module)
        this.boostTimer = 0;
        this.oilTimer = 0;
        this.catchupFactor = 0;

        this.stuckTimer = 0;
        this.lastTrackIdx = 0;
    }

    placeOnTrack(progress, laneOffset) {
        this.progress = ((progress % 1) + 1) % 1;
        this.lap = 0;
        this.totalProgress = this.progress;
        // Remember where this car started so we can skip the partial first lap
        // (grid cars start at ~0.97 and cross the line after only ~3% of the track)
        this._startProgress = this.progress;
        this.speed = 0;
        this.bestLapTime = Infinity;
        this.currentLapTime = 0;
        this.lastLapTime = 0;
        this.lapTimes = [];
        this.lapStartTime = 0;
        this.targetLane = laneOffset / (Track.getWidth() / 2);
        this.overtakeTimer = 0;
        this.defendTimer = 0;
        this.boostTimer = 0;
        this.oilTimer = 0;
        this.catchupFactor = 0;
        this.stuckTimer = 0;

        const pos = Track.getPositionAt(this.progress, laneOffset);
        this.x = pos.x;
        this.y = pos.y;
        this.angle = pos.angle;
        this.trackIndex = Math.floor(this.progress * Track.getPointCount());
        this.lastTrackIdx = this.trackIndex;
    }

    // Called by PowerUps module
    activateBoost(duration) {
        this.boostTimer = Math.max(this.boostTimer, duration);
        Effects.addSparks(this.x, this.y, 6);
    }

    activateOilSlick() {
        if (this.oilTimer <= 0) {
            this.oilTimer = 1.8;
            this.speed *= 0.55;
            Effects.addSparks(this.x, this.y, 10);
        }
    }

    update(dt, allCars, raceTime, timeSinceStart, noCollisions) {
        if (this.lap === 0 && this.lapStartTime === 0) this.lapStartTime = raceTime;

        const ai = this.runAI(allCars, dt, timeSinceStart);
        this.applyPhysics(ai.throttle, ai.brake, ai.steer, dt);

        if (!noCollisions && timeSinceStart > 4000) this.resolveCollisions(allCars);

        this.detectStuck(dt);
        this.updateProgress(raceTime);
        this.emitEffects(ai.brake);
    }

    // -------------------------------------------------------------------------
    // Helpers
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

    // -------------------------------------------------------------------------
    // Main AI
    // -------------------------------------------------------------------------

    runAI(allCars, dt, timeSinceStart) {
        const n = Track.getPointCount();
        const tw = Track.getWidth();
        const maxSpeed = 350 * this.stats.topSpeed;
        const isGrace = timeSinceStart < 4000;
        const isLap1  = this.lap === 0;

        // --- LOCATE ON TRACK ---
        const closest = Track.closestPoint(this.x, this.y);
        this.trackIndex = closest.index;
        const norm = Track.normalAt(this.trackIndex);
        const cp   = Track.getPoints()[this.trackIndex];
        const lateralOffset = (this.x - cp.x) * norm.x + (this.y - cp.y) * norm.y;
        this.offTrack = Math.abs(lateralOffset) > tw * 0.45;

        // --- PHYSICS-BASED LOOK-AHEAD ---
        const brakingDecel = 450 * this.stats.braking;
        const brakingPx = (this.speed * this.speed) / (2 * brakingDecel);
        const pxPerPt   = Track.getTrackLength() / n;
        const brakePts  = Math.max(10, Math.min(85, Math.round(brakingPx / pxPerPt)));
        const nearPts   = Math.max(4,  Math.round(brakePts * 0.2));

        const maxCurv = this.maxCurvatureAhead(nearPts, brakePts);
        const curNear = this.maxCurvatureAhead(2, nearPts);
        const isOnStraight = maxCurv < 0.018;

        // --- CORNER SPEED ---
        const cornerSpeed = maxSpeed * Math.max(0.45, 1 - maxCurv * 2.6 / this.stats.cornering);

        // --- RACING LINE (outside → apex → outside with per-car personality) ---
        // Detect corner phase: approaching (curv increasing) vs apex vs exiting
        const curvAhead = this.maxCurvatureAhead(nearPts, Math.round(brakePts * 0.6));
        const approaching = curvAhead > curNear * 1.3 && curvAhead > 0.02;
        const exiting     = curNear > curvAhead * 1.3 && curNear > 0.025;

        let racingLine = this.lineVariance;
        if (curNear > 0.018 || maxCurv > 0.018) {
            const dir = this.getCurveDirection(this.trackIndex);
            if (approaching) {
                // Wide entry — go to outside before turn-in
                racingLine = dir * 0.38 + this.lineVariance;
            } else if (exiting) {
                // Track out — drift to outside
                racingLine = dir * 0.28 + this.lineVariance;
            } else {
                // Apex: cut inside aggressively (varies per car)
                racingLine = -dir * this.apexCut + this.lineVariance;
            }
        }

        // --- TIMER UPKEEP ---
        this.overtakeTimer = Math.max(0, this.overtakeTimer - dt);
        this.defendTimer   = Math.max(0, this.defendTimer   - dt);
        const isOvertaking = this.overtakeTimer > 0;
        const isDefending  = this.defendTimer   > 0;

        // --- COMPUTE TARGET LATERAL POSITION ---
        const laneTarget = (isOvertaking || isDefending)
            ? this.targetLane
            : racingLine * 0.6 + this.targetLane * 0.4;
        const desiredOffset = laneTarget * (tw * 0.3);

        // --- PURE PURSUIT STEERING ---
        // Aim at a look-ahead point on the desired lane — eliminates "checkpoint" corner behavior.
        const lookPts = Math.max(20, Math.round(this.speed * 0.13));
        const lookIdx = (this.trackIndex + lookPts) % n;
        const lookPt  = Track.getPositionAt(lookIdx / n, desiredOffset);
        const dxL = lookPt.x - this.x;
        const dyL = lookPt.y - this.y;
        let targetAngle = Math.atan2(dyL, dxL);

        let angleErr = targetAngle - this.angle;
        while (angleErr >  Math.PI) angleErr -= Math.PI * 2;
        while (angleErr < -Math.PI) angleErr += Math.PI * 2;

        let steer = angleErr * 2.2;

        // Hard correction if near track edge
        if (Math.abs(lateralOffset) > tw * 0.4) {
            steer += -(lateralOffset / tw) * 3.0;
        }

        // Oil slick: reduce steering authority
        if (this.oilTimer > 0) {
            steer *= 0.4;
        }

        steer = Math.max(-1, Math.min(1, steer));

        // --- BASE THROTTLE / BRAKE ---
        let throttle = 0, brake = 0;
        this.braking = false;

        const speedExcess = this.speed - cornerSpeed;
        if (speedExcess > 8) {
            const brakePow = Math.min(0.92, speedExcess / (maxSpeed * 0.28) * this.stats.braking);
            brake    = brakePow;
            throttle = 0;
            this.braking = true;
        } else if (speedExcess > -8) {
            throttle = 0.12;
        } else {
            throttle = isOnStraight ? 1.0 : Math.min(1.0, 0.5 + (-speedExcess) / (maxSpeed * 0.3));
        }

        if (this.offTrack) {
            throttle = Math.min(throttle, 0.3);
            brake    = Math.max(brake, 0.2);
        }

        // Oil slick: cut throttle
        if (this.oilTimer > 0) {
            throttle = Math.min(throttle, 0.25);
        }

        // --- SCAN FOR NEARBY CARS ---
        this.blocked = false;
        this.slipstreaming = false;

        const cosA = Math.cos(this.angle), sinA = Math.sin(this.angle);

        let carAhead    = null;
        let carBehind   = null;
        let carAlongside = null;

        for (const other of allCars) {
            if (other === this) continue;
            const dx = other.x - this.x, dy = other.y - this.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > 200) continue;

            const dotFwd  =  dx * cosA + dy * sinA;
            const dotSide = -dx * sinA + dy * cosA;
            const isTeam  = other.team === this.team;

            if (isGrace) {
                if (dotFwd > 0 && dotFwd < 55 && Math.abs(dotSide) < 30) {
                    throttle = Math.min(throttle, 0.5);
                }
                continue;
            }

            if (dotFwd > 35 && dotFwd < 140 && Math.abs(dotSide) < 24) {
                this.slipstreaming = true;
            }

            if (dotFwd > 0 && dotFwd < 110 && Math.abs(dotSide) < 28) {
                if (!carAhead || dotFwd < carAhead.fwd) {
                    carAhead = { car: other, dist, fwd: dotFwd, side: dotSide, isTeam };
                }
            }

            if (dotFwd < 0 && dotFwd > -80 && Math.abs(dotSide) < 30) {
                if (!carBehind || -dotFwd < -carBehind.fwd) {
                    carBehind = { car: other, dist, fwd: dotFwd, side: dotSide, isTeam };
                }
            }

            if (Math.abs(dotFwd) < 32 && Math.abs(dotSide) < 44 && dist < 50) {
                if (!carAlongside || dist < carAlongside.dist) {
                    carAlongside = { car: other, dist, fwd: dotFwd, side: dotSide, isTeam };
                }
            }
        }

        if (isGrace) {
            if (this.slipstreaming) throttle = Math.min(1.0, throttle + 0.15);
            return { throttle, brake, steer };
        }

        // --- BLOCKED: CAR DIRECTLY AHEAD ---
        if (carAhead) {
            const { fwd, side, isTeam } = carAhead;
            this.blocked = true;

            if (isOvertaking) {
                // Actively overtaking: don't slow down. Emergency brake only if truly about to hit.
                if (fwd < 22 && Math.abs(side) < 22) {
                    throttle = Math.min(throttle, 0.25);
                    brake    = Math.max(brake, 0.4);
                }
            } else {
                // Following mode
                if (fwd < 28) {
                    throttle = 0;
                    brake = Math.max(brake, Math.min(0.65, (28 - fwd) / 18));
                } else if (fwd < 55) {
                    throttle = Math.min(throttle, 0.35 + (fwd - 28) / 60);
                } else {
                    throttle = Math.min(throttle, 0.82);
                }

                // --- DECIDE TO OVERTAKE ---
                // Lap 1: be cautious, no risky moves
                const canTryOvertake = !isLap1 || (isTeam === false && this.stats.aggression > 0.7 && isOnStraight);

                if (this.overtakeTimer <= 0 && canTryOvertake) {
                    let commit = false;
                    let overtakeSide = side >= 0 ? -1 : 1;

                    if (isTeam) {
                        const isFaster = this.bestLapTime < carAhead.car.bestLapTime * 0.97;
                        if (isFaster && isOnStraight && fwd < 90) commit = true;
                    } else {
                        if (isOnStraight && this.stats.aggression > 0.3 && fwd < 100) {
                            commit = true;
                        }
                        if (this.stats.braking > 1.05 && !isOnStraight && maxCurv > 0.02 && maxCurv < 0.08) {
                            const futurePts = Math.round(brakePts * 0.6);
                            const cornerDir = this.getCurveDirection((this.trackIndex + futurePts) % n);
                            overtakeSide = -cornerDir;
                            commit = true;
                        }
                        if (this.stats.aggression > 0.65 && maxCurv < 0.055 && fwd < 90) {
                            commit = true;
                        }
                        if (this.stats.cornering > 1.08 && curNear > 0.02 && maxCurv < 0.02 && fwd < 90) {
                            commit = true;
                        }
                    }

                    if (commit) {
                        const targetOff = overtakeSide * (tw * 0.26);
                        if (Math.abs(targetOff - lateralOffset) > 8) {
                            this.overtakeSide  = overtakeSide;
                            this.targetLane    = overtakeSide * 0.82;
                            this.overtakeTimer = 2.0 + Math.random() * 0.8;
                        }
                    }
                }
            }
        } else if (isOvertaking) {
            this.overtakeTimer = 0;
        }

        // --- SIDE-BY-SIDE: gentle push-away (disabled during active overtake) ---
        if (carAlongside && !isOvertaking) {
            const { side } = carAlongside;
            if (side > 0) steer = Math.min(steer, -0.28);
            else           steer = Math.max(steer,  0.28);
        }

        // --- DEFENDING ---
        if (carBehind && !isOvertaking && !isLap1 && this.defendTimer <= 0) {
            const { fwd, side, isTeam } = carBehind;
            if (!isTeam && -fwd < 50 && this.stats.aggression > 0.35 && maxCurv < 0.05) {
                this.targetLane  = side > 0 ? 0.32 : -0.32;
                this.defendTimer = 0.9;
            }
        }

        // --- RETURN TO LINE ---
        if (!this.blocked && !isOvertaking && !isDefending) {
            this.targetLane *= 0.93;
        }

        // --- SLIPSTREAM BOOST ---
        if (this.slipstreaming) throttle = Math.min(1.0, throttle + 0.18);

        return { throttle, brake, steer };
    }

    // -------------------------------------------------------------------------
    // Physics
    // -------------------------------------------------------------------------

    applyPhysics(throttle, brake, steer, dt) {
        const baseMaxSpeed = 350 * this.stats.topSpeed;
        // Catch-up: backmarkers get a speed boost
        const maxSpeed  = baseMaxSpeed * (1 + this.catchupFactor * 0.18);
        const accel     = 220 * this.stats.accel;
        const brkForce  = 450 * this.stats.braking;
        const engBrake  = 30;
        const drag      = 0.15;
        const steerRate = 3.0;

        let force = throttle * accel - brake * brkForce - engBrake - this.speed * drag;

        // Boost pad: big extra force (and override max speed slightly)
        if (this.boostTimer > 0) {
            this.boostTimer -= dt;
            force += accel * 1.0; // double accel during boost
        }

        this.speed = Math.max(0, Math.min(maxSpeed * (this.boostTimer > 0 ? 1.35 : 1), this.speed + force * dt));

        if (this.offTrack) this.speed *= (1 - dt * 2.0);

        // Oil slick: decay
        if (this.oilTimer > 0) this.oilTimer -= dt;

        // Steering
        const steerFactor = steerRate * (1 - (this.speed / baseMaxSpeed) * 0.35);
        this.angle += steer * steerFactor * dt;

        this.x += Math.cos(this.angle) * this.speed * dt;
        this.y += Math.sin(this.angle) * this.speed * dt;

        // Hard boundary
        const cl = Track.closestPoint(this.x, this.y);
        const maxDist = Track.getWidth() * 0.52;
        if (cl.dist > maxDist) {
            const cpts = Track.getPoints();
            const ccp  = cpts[cl.index];
            const dx = this.x - ccp.x, dy = this.y - ccp.y;
            const d  = Math.sqrt(dx * dx + dy * dy);
            if (d > 0) {
                this.x = ccp.x + (dx / d) * maxDist;
                this.y = ccp.y + (dy / d) * maxDist;
            }
            this.speed *= 0.92;
        }
    }

    // -------------------------------------------------------------------------
    // Collisions
    // -------------------------------------------------------------------------

    resolveCollisions(allCars) {
        for (const other of allCars) {
            if (other === this) continue;
            const dx = other.x - this.x, dy = other.y - this.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const minDist = this.collisionRadius + other.collisionRadius;
            if (dist >= minDist || dist < 0.01) continue;

            const overlap = minDist - dist;
            const nx = dx / dist, ny = dy / dist;
            const push = overlap * 0.6;
            this.x  -= nx * push; this.y  -= ny * push;
            other.x += nx * push; other.y += ny * push;

            const isTeam = other.team === this.team;
            const keep = isTeam ? 0.97 : 0.92;
            const xfer = isTeam ? 0.02 : 0.05;
            const mySpd = this.speed, thSpd = other.speed;
            this.speed  = mySpd * keep + thSpd * xfer;
            other.speed = thSpd * keep + mySpd * xfer;

            const deflect = isTeam ? 0.02 : 0.04;
            this.angle  -= nx * deflect;
            other.angle += nx * deflect;

            if (!isTeam) Effects.addSparks((this.x + other.x) / 2, (this.y + other.y) / 2, 4);
        }
    }

    // -------------------------------------------------------------------------
    // Unstick
    // -------------------------------------------------------------------------

    detectStuck(dt) {
        const idxDiff = Math.abs(this.trackIndex - this.lastTrackIdx);
        if (idxDiff < 2 && this.speed < 10) {
            this.stuckTimer += dt;
            if (this.stuckTimer > 1.0) {
                const tn = Track.getPointCount();
                const ni = (this.trackIndex + 5) % tn;
                const pos = Track.getPositionAt(ni / tn, this.targetLane * 20);
                this.x = pos.x; this.y = pos.y; this.angle = pos.angle;
                this.speed = 80;
                this.stuckTimer = 0;
            }
        } else {
            this.stuckTimer = 0;
        }
        this.lastTrackIdx = this.trackIndex;
    }

    // -------------------------------------------------------------------------
    // Progress
    // -------------------------------------------------------------------------

    updateProgress(raceTime) {
        const tn = Track.getPointCount();
        const newProg = this.trackIndex / tn;
        if (newProg - this.progress < -0.5) {
            this.lap++;
            const lapTime = raceTime - this.lapStartTime;
            // Skip the partial first crossing for grid cars: they start at ~0.97 so their
            // first "lap" is only ~3% of the track (~2 s) and would corrupt best-lap data.
            // Cars starting at progress ≤ 0.5 (qualifying) cross after a full lap — keep those.
            const isPartialFirstLap = this.lap === 1 && (this._startProgress || 0) > 0.5;
            if (!isPartialFirstLap && lapTime > 2000) {
                this.lastLapTime = lapTime;
                this.lapTimes.push(lapTime);
                if (lapTime < this.bestLapTime) this.bestLapTime = lapTime;
            }
            this.lapStartTime = raceTime;
        }
        this.progress = newProg;
        this.totalProgress = this.lap + this.progress;
        this.currentLapTime = raceTime - this.lapStartTime;
    }

    // -------------------------------------------------------------------------
    // Effects
    // -------------------------------------------------------------------------

    emitEffects(brakeAmount) {
        if (this.braking && brakeAmount > 0.4 && this.speed > 60) {
            Effects.addSkidMark(this.x, this.y, this.angle, brakeAmount);
            if (brakeAmount > 0.6) Effects.addTireSmoke(this.x, this.y, this.angle, brakeAmount);
        }
        if (this.slipstreaming && this.speed > 100) {
            Effects.addSlipstreamLines(this.x, this.y, this.angle);
        }
        if (this.offTrack && this.speed > 30) {
            Effects.addDirt(this.x, this.y, this.angle);
        }
        // Boost trail
        if (this.boostTimer > 0) {
            Effects.addTireSmoke(this.x, this.y, this.angle + Math.PI, 0.5);
        }
    }

    // -------------------------------------------------------------------------
    // Draw
    // -------------------------------------------------------------------------

    draw(ctx) {
        if (!this.image || !this.image.complete) return;

        ctx.save();
        ctx.translate(this.x, this.y);
        ctx.rotate(this.angle);

        // Rainbow highlight tracing the car outline for P1 (race leader)
        if (this.position === 1) {
            const now = Date.now();
            ctx.save();
            ctx.lineWidth = 2.8;
            ctx.lineCap = 'round';
            // Outline box slightly larger than the car sprite (52×28)
            const hw = 30, hh = 17, cr = 5;
            const N  = 48; // segments around the perimeter
            for (let i = 0; i < N; i++) {
                const p0 = _carPerimPt(i / N,     hw, hh, cr);
                const p1 = _carPerimPt((i + 1) / N, hw, hh, cr);
                const hue = ((now * 0.09 + (i / N) * 360) % 360 + 360) % 360;
                ctx.strokeStyle = `hsl(${hue}, 100%, 62%)`;
                ctx.shadowColor  = `hsl(${hue}, 100%, 72%)`;
                ctx.shadowBlur   = 7;
                ctx.globalAlpha  = 0.92;
                ctx.beginPath();
                ctx.moveTo(p0.x, p0.y);
                ctx.lineTo(p1.x, p1.y);
                ctx.stroke();
            }
            ctx.restore();
        }

        // Boost glow
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

        // Brake lights
        if (this.braking) {
            ctx.fillStyle = 'rgba(255,0,0,0.8)';
            ctx.fillRect(-w / 2 - 1, -5, 3, 4);
            ctx.fillRect(-w / 2 - 1,  2, 3, 4);
        }

        // Position badge
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(-8, -h / 2 - 14, 16, 11);
        ctx.fillStyle = this.position === 1 ? '#FFD700' : '#fff';
        ctx.font = 'bold 10px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`P${this.position}`, 0, -h / 2 - 8);

        ctx.restore();
    }
}
