/**
 * Car with 2D physics and tactical AI.
 * Each car has unique stats that meaningfully affect driving behaviour.
 */

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
        this.targetLane = 0;       // -1..1 normalised lane target
        this.overtakeTimer = 0;    // counts down while executing a pass
        this.overtakeSide = 0;     // -1 left, +1 right
        this.defendTimer = 0;
        this.blocked = false;
        this.braking = false;
        this.slipstreaming = false;
        this.offTrack = false;

        this.stuckTimer = 0;
        this.lastTrackIdx = 0;
    }

    placeOnTrack(progress, laneOffset) {
        this.progress = ((progress % 1) + 1) % 1;
        this.lap = 0;
        this.totalProgress = 0;
        this.speed = 0;
        this.bestLapTime = Infinity;
        this.currentLapTime = 0;
        this.lastLapTime = 0;
        this.lapTimes = [];
        this.lapStartTime = 0;
        this.targetLane = laneOffset / (Track.getWidth() / 2);
        this.overtakeTimer = 0;
        this.defendTimer = 0;
        this.stuckTimer = 0;

        const pos = Track.getPositionAt(this.progress, laneOffset);
        this.x = pos.x;
        this.y = pos.y;
        this.angle = pos.angle;
        this.trackIndex = Math.floor(this.progress * Track.getPointCount());
        this.lastTrackIdx = this.trackIndex;
    }

    update(dt, allCars, raceTime, timeSinceStart) {
        if (this.lap === 0 && this.lapStartTime === 0) this.lapStartTime = raceTime;

        const ai = this.runAI(allCars, dt, timeSinceStart);
        this.applyPhysics(ai.throttle, ai.brake, ai.steer, dt);

        if (timeSinceStart > 4000) this.resolveCollisions(allCars);

        this.detectStuck(dt);
        this.updateProgress(raceTime);
        this.emitEffects(ai.brake);
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    /** Cross-product sign of consecutive track segments. +1 = right turn, -1 = left turn. */
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

    /**
     * Sample the maximum curvature over a zone from startPts to endPts track
     * indices ahead of the current position.
     */
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

        // --- LOCATE ON TRACK ---
        const closest = Track.closestPoint(this.x, this.y);
        this.trackIndex = closest.index;
        const trackAngle = Track.angleAt(this.trackIndex);
        const norm = Track.normalAt(this.trackIndex);
        const cp = Track.getPoints()[this.trackIndex];
        const lateralOffset = (this.x - cp.x) * norm.x + (this.y - cp.y) * norm.y;
        this.offTrack = Math.abs(lateralOffset) > tw * 0.45;

        // --- PHYSICS-BASED LOOK-AHEAD ---
        // Braking distance = v²/(2a). Better brakers have higher decel → shorter
        // stopping distance → they can afford to look less far ahead (brake later).
        const brakingDecel = 450 * this.stats.braking;
        const brakingPx = (this.speed * this.speed) / (2 * brakingDecel);
        const pxPerPt = Track.getTrackLength() / n;
        // Span from ~15% to 100% of braking distance (not 0 so we don't react to current curv)
        const brakePts = Math.max(10, Math.min(85, Math.round(brakingPx / pxPerPt)));
        const nearPts  = Math.max(4,  Math.round(brakePts * 0.2));

        // Max curvature in braking zone
        const maxCurv  = this.maxCurvatureAhead(nearPts, brakePts);
        // Curvature right under the car (for racing line)
        const curNear  = this.maxCurvatureAhead(2, nearPts);
        const isOnStraight = maxCurv < 0.018;

        // --- CORNER SPEED ---
        // Higher cornering stat lets car carry more speed through curves.
        const cornerSpeed = maxSpeed * Math.max(0.45, 1 - maxCurv * 2.6 / this.stats.cornering);

        // --- RACING LINE ---
        // In corners, move toward inside of turn. Higher cornering = tighter line.
        let racingLine = 0;
        if (curNear > 0.022) {
            const dir = this.getCurveDirection(this.trackIndex);
            racingLine = -dir * 0.55 * Math.min(1.25, this.stats.cornering);
        }

        // --- TIMER UPKEEP ---
        this.overtakeTimer = Math.max(0, this.overtakeTimer - dt);
        this.defendTimer   = Math.max(0, this.defendTimer   - dt);
        const isOvertaking = this.overtakeTimer > 0;
        const isDefending  = this.defendTimer   > 0;

        // --- STEERING ---
        // When executing a manoeuvre, use the committed lane; otherwise blend racing line.
        const laneTarget = (isOvertaking || isDefending)
            ? this.targetLane
            : racingLine * 0.55 + this.targetLane * 0.45;
        const desiredOffset = laneTarget * (tw * 0.3);
        const offsetErr = desiredOffset - lateralOffset;

        let angleErr = trackAngle - this.angle;
        while (angleErr >  Math.PI) angleErr -= Math.PI * 2;
        while (angleErr < -Math.PI) angleErr += Math.PI * 2;

        let steer = angleErr * 2.5 + (offsetErr / tw) * 3.0;
        if (Math.abs(lateralOffset) > tw * 0.38) {
            steer = angleErr * 4.0 + (offsetErr / tw) * 5.0;
        }
        steer = Math.max(-1, Math.min(1, steer));

        // --- BASE THROTTLE / BRAKE ---
        let throttle = 0, brake = 0;
        this.braking = false;

        const speedExcess = this.speed - cornerSpeed;
        if (speedExcess > 8) {
            // Need to scrub speed: brake proportionally to excess
            const brakePower = Math.min(0.92, speedExcess / (maxSpeed * 0.28) * this.stats.braking);
            brake = brakePower;
            throttle = 0;
            this.braking = true;
        } else if (speedExcess > -8) {
            // Right at target speed: coast with a touch of throttle
            throttle = 0.12;
        } else {
            // Under target: accelerate
            throttle = isOnStraight ? 1.0 : Math.min(1.0, 0.5 + (-speedExcess) / (maxSpeed * 0.3));
        }

        if (this.offTrack) {
            throttle = Math.min(throttle, 0.3);
            brake    = Math.max(brake, 0.2);
        }

        // --- SCAN FOR NEARBY CARS ---
        this.blocked = false;
        this.slipstreaming = false;

        const cosA = Math.cos(this.angle), sinA = Math.sin(this.angle);

        let carAhead    = null;   // nearest car directly in our path
        let carBehind   = null;   // nearest car chasing us
        let carAlongside = null;  // car we are currently side-by-side with

        for (const other of allCars) {
            if (other === this) continue;
            const dx = other.x - this.x, dy = other.y - this.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > 200) continue;

            const dotFwd  =  dx * cosA + dy * sinA;    // + = ahead of us
            const dotSide = -dx * sinA + dy * cosA;    // + = left of us

            if (isGrace) {
                // During grace: just keep distance, no racing
                if (dotFwd > 0 && dotFwd < 55 && Math.abs(dotSide) < 30) {
                    throttle = Math.min(throttle, 0.5);
                }
                continue;
            }

            const isTeam = other.team === this.team;

            // Slipstream: nearly in line with car ahead
            if (dotFwd > 35 && dotFwd < 140 && Math.abs(dotSide) < 24) {
                this.slipstreaming = true;
            }

            // Car in our lane, ahead
            if (dotFwd > 0 && dotFwd < 110 && Math.abs(dotSide) < 28) {
                if (!carAhead || dotFwd < carAhead.fwd) {
                    carAhead = { car: other, dist, fwd: dotFwd, side: dotSide, isTeam };
                }
            }

            // Car behind us
            if (dotFwd < 0 && dotFwd > -80 && Math.abs(dotSide) < 30) {
                if (!carBehind || -dotFwd < -carBehind.fwd) {
                    carBehind = { car: other, dist, fwd: dotFwd, side: dotSide, isTeam };
                }
            }

            // Side-by-side: roughly level, close laterally
            if (Math.abs(dotFwd) < 32 && Math.abs(dotSide) < 44 && dist < 50) {
                if (!carAlongside || dist < carAlongside.dist) {
                    carAlongside = { car: other, dist, fwd: dotFwd, side: dotSide, isTeam };
                }
            }
        }

        if (isGrace) {
            // Don't apply any racing logic during grace period
            if (this.slipstreaming) throttle = Math.min(1.0, throttle + 0.15);
            return { throttle, brake, steer };
        }

        // --- BLOCKED: CAR DIRECTLY AHEAD ---
        if (carAhead) {
            const { fwd, side, isTeam } = carAhead;
            this.blocked = true;

            if (isOvertaking) {
                // *** ACTIVELY OVERTAKING ***
                // Don't limit throttle — let the lateral move do the work.
                // Only emergency brake if we somehow stayed directly behind and are about to hit.
                if (fwd < 22 && Math.abs(side) < 22) {
                    throttle = Math.min(throttle, 0.25);
                    brake = Math.max(brake, 0.4);
                }
                // If no car is ahead in our lane (we slid past), clear overtake early
            } else {
                // *** FOLLOWING MODE ***
                if (fwd < 28) {
                    // Very close: don't hit them
                    throttle = 0;
                    brake = Math.max(brake, Math.min(0.65, (28 - fwd) / 18));
                } else if (fwd < 55) {
                    // Close: ease off
                    throttle = Math.min(throttle, 0.35 + (fwd - 28) / 60);
                } else {
                    // Moderate gap: slight ease
                    throttle = Math.min(throttle, 0.82);
                }

                // *** DECIDE TO OVERTAKE ***
                if (this.overtakeTimer <= 0) {
                    let commit = false;
                    // Choose which side to go: opposite of where the car is laterally,
                    // or to the inside of the next corner.
                    let overtakeSide = side >= 0 ? -1 : 1; // opposite side of blocker

                    if (isTeam) {
                        // Only pass teammate if clearly faster and on a straight
                        const isFaster = this.bestLapTime < carAhead.car.bestLapTime * 0.97;
                        if (isFaster && isOnStraight && fwd < 90) commit = true;
                    } else {
                        // Speed cars & moderate aggression: pass on straights
                        if (isOnStraight && this.stats.aggression > 0.3 && fwd < 100) {
                            commit = true;
                            // Use slipstream side preference: pull out same direction we want to go
                        }
                        // Late brakers: set up a dive into the inside of the upcoming corner
                        if (this.stats.braking > 1.05 && !isOnStraight && maxCurv > 0.02 && maxCurv < 0.08) {
                            const futurePts = Math.round(brakePts * 0.6);
                            const cornerDir = this.getCurveDirection((this.trackIndex + futurePts) % n);
                            overtakeSide = -cornerDir; // inside of corner
                            commit = true;
                        }
                        // Aggressive/risky: attempt in moderate bends too
                        if (this.stats.aggression > 0.65 && maxCurv < 0.055 && fwd < 90) {
                            commit = true;
                        }
                        // Cornering specialist: pass on corner exit (curv dropping)
                        if (this.stats.cornering > 1.08 && curNear > 0.02 && maxCurv < 0.02 && fwd < 90) {
                            commit = true;
                        }
                    }

                    if (commit) {
                        // Make sure the target lane is actually clear (not blocked by another car)
                        const targetOff = overtakeSide * (tw * 0.26);
                        if (Math.abs(targetOff - lateralOffset) > 8) {
                            this.overtakeSide = overtakeSide;
                            this.targetLane   = overtakeSide * 0.82;
                            this.overtakeTimer = 2.0 + Math.random() * 0.8;
                        }
                    }
                }
            }
        } else if (isOvertaking) {
            // No car ahead in our lane: pass is complete, return to line
            this.overtakeTimer = 0;
        }

        // --- SIDE-BY-SIDE: avoid sideswiping ---
        // Apply only when NOT in the middle of an overtake (otherwise we fight ourselves)
        if (carAlongside && !isOvertaking) {
            const { side } = carAlongside;
            // Gently steer away
            if (side > 0) steer = Math.min(steer, -0.28);
            else           steer = Math.max(steer,  0.28);
        }

        // --- DEFENDING: block attacker coming from behind ---
        if (carBehind && !isOvertaking && this.defendTimer <= 0) {
            const { fwd, side, isTeam } = carBehind;
            if (!isTeam && -fwd < 50 && this.stats.aggression > 0.35 && maxCurv < 0.05) {
                // Move to cover the side they're approaching from
                this.targetLane  = side > 0 ? 0.32 : -0.32;
                this.defendTimer = 0.9;
            }
        }

        // --- RETURN TO LINE when no active manoeuvre ---
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
        const maxSpeed  = 350 * this.stats.topSpeed;
        const accel     = 220 * this.stats.accel;
        const brkForce  = 450 * this.stats.braking;
        const engBrake  = 30;
        const drag      = 0.15;
        const steerRate = 3.0;

        let force = throttle * accel - brake * brkForce - engBrake - this.speed * drag;
        this.speed = Math.max(0, Math.min(maxSpeed, this.speed + force * dt));

        if (this.offTrack) this.speed *= (1 - dt * 2.0);

        const steerFactor = steerRate * (1 - (this.speed / maxSpeed) * 0.35);
        this.angle += steer * steerFactor * dt;

        this.x += Math.cos(this.angle) * this.speed * dt;
        this.y += Math.sin(this.angle) * this.speed * dt;

        // Hard boundary: don't leave the track surface
        const cl = Track.closestPoint(this.x, this.y);
        const maxDist = Track.getWidth() * 0.52;
        if (cl.dist > maxDist) {
            const cps = Track.getPoints();
            const ccp = cps[cl.index];
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
    // Progress tracking
    // -------------------------------------------------------------------------

    updateProgress(raceTime) {
        const tn = Track.getPointCount();
        const newProg = this.trackIndex / tn;
        if (newProg - this.progress < -0.5) {
            this.lap++;
            const lapTime = raceTime - this.lapStartTime;
            if (lapTime > 2000) {
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
    }

    // -------------------------------------------------------------------------
    // Draw
    // -------------------------------------------------------------------------

    draw(ctx) {
        if (!this.image || !this.image.complete) return;

        ctx.save();
        ctx.translate(this.x, this.y);
        ctx.rotate(this.angle);

        // Shadow
        ctx.save();
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.ellipse(2, 2, 20, 10, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        const w = 40, h = 22;
        ctx.drawImage(this.image, -w / 2, -h / 2, w, h);

        // Brake lights
        if (this.braking) {
            ctx.fillStyle = 'rgba(255,0,0,0.7)';
            ctx.fillRect(-w / 2 - 1, -4, 3, 3);
            ctx.fillRect(-w / 2 - 1,  1, 3, 3);
        }

        // Position badge
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(-6, -h / 2 - 11, 12, 9);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 8px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`P${this.position}`, 0, -h / 2 - 7);

        ctx.restore();
    }
}
