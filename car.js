/**
 * Car with 2D physics and tactical AI.
 * Each car has unique stats and driving style.
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

        // Unique car stats from profile
        const profile = CAR_PROFILES[number];
        this.stats = { ...profile };

        // Physics
        this.x = 0;
        this.y = 0;
        this.angle = 0;
        this.speed = 0;           // px/sec
        this.collisionRadius = 18;

        // Race state
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
        this.defendTimer = 0;
        this.blocked = false;
        this.braking = false;
        this.slipstreaming = false;
        this.offTrack = false;

        // Collision unstick timer
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
        if (this.lap === 0 && this.lapStartTime === 0) {
            this.lapStartTime = raceTime;
        }

        const ai = this.runAI(allCars, dt, timeSinceStart);
        this.applyPhysics(ai.throttle, ai.brake, ai.steer, dt);

        // Grace period: no collisions for first 4 seconds after green light
        if (timeSinceStart > 4000) {
            this.resolveCollisions(allCars);
        }

        this.detectStuck(dt);
        this.updateProgress(raceTime);
        this.emitEffects(ai.brake);
    }

    /** Determine if upcoming curve turns left (-1) or right (+1). */
    getCurveDirection(idx) {
        const n = Track.getPointCount();
        const pts = Track.getPoints();
        const look = 15;
        const p0 = pts[idx];
        const p1 = pts[(idx + look) % n];
        const p2 = pts[(idx + look * 2) % n];
        const dx1 = p1.x - p0.x, dy1 = p1.y - p0.y;
        const dx2 = p2.x - p1.x, dy2 = p2.y - p1.y;
        const cross = dx1 * dy2 - dy1 * dx2;
        return cross > 0 ? 1 : -1;
    }

    runAI(allCars, dt, timeSinceStart) {
        const n = Track.getPointCount();
        const tw = Track.getWidth();
        const maxSpeed = 350 * this.stats.topSpeed;
        const isGracePeriod = timeSinceStart < 4000;

        // ===== LOCATE SELF =====
        const closest = Track.closestPoint(this.x, this.y);
        this.trackIndex = closest.index;
        const trackAngle = Track.angleAt(this.trackIndex);

        const norm = Track.normalAt(this.trackIndex);
        const pts = Track.getPoints();
        const cp = pts[this.trackIndex];
        const toCarX = this.x - cp.x, toCarY = this.y - cp.y;
        const lateralOffset = toCarX * norm.x + toCarY * norm.y;
        this.offTrack = Math.abs(lateralOffset) > tw * 0.45;

        // ===== CURVATURE SAMPLING =====
        // Braking stat affects how far ahead we look: higher = look less = brake later
        const speedFactor = Math.max(1, this.speed / 50);
        const brakingLook = 1 / this.stats.braking;
        const nearIdx = (this.trackIndex + Math.floor(8 * speedFactor)) % n;
        const midIdx = (this.trackIndex + Math.floor(18 * speedFactor * brakingLook)) % n;
        const farIdx = (this.trackIndex + Math.floor(35 * speedFactor * brakingLook)) % n;
        const curvNear = Track.curvatureAt(nearIdx);
        const curvMid = Track.curvatureAt(midIdx);
        const curvFar = Track.curvatureAt(farIdx);
        const maxCurv = Math.max(curvNear, curvMid * 0.8, curvFar * 0.5);

        // Corner speed: cornering stat lets car carry more speed through curves
        const cornerSpeed = maxSpeed * Math.max(0.25, 1 - maxCurv * (4 / this.stats.cornering));

        // ===== RACING LINE =====
        // Higher cornering cars cut corners more aggressively
        let racingLine = 0;
        if (curvNear > 0.04) {
            const curvDir = this.getCurveDirection(this.trackIndex);
            racingLine = -curvDir * 0.6 * Math.min(1.2, this.stats.cornering);
        }

        // ===== STEERING =====
        const activeLane = this.overtakeTimer > 0 || this.defendTimer > 0
            ? this.targetLane
            : racingLine * 0.6 + this.targetLane * 0.4;
        const desiredOffset = activeLane * (tw * 0.3);
        const offsetError = desiredOffset - lateralOffset;

        let angleError = trackAngle - this.angle;
        while (angleError > Math.PI) angleError -= Math.PI * 2;
        while (angleError < -Math.PI) angleError += Math.PI * 2;

        let steer = angleError * 2.5 + (offsetError / tw) * 3.0;
        if (Math.abs(lateralOffset) > tw * 0.38) {
            steer = angleError * 4.0 + (offsetError / tw) * 5.0;
        }
        steer = Math.max(-1, Math.min(1, steer));

        // ===== THROTTLE & BRAKING =====
        let throttle = 0;
        let brake = 0;
        this.braking = false;

        if (maxCurv < 0.03) {
            // Straight: full power
            throttle = 1.0;
        } else if (this.speed > cornerSpeed * 1.05) {
            // Too fast for upcoming corner: brake
            const brakePower = Math.min(0.9, (this.speed - cornerSpeed) / cornerSpeed);
            brake = brakePower * this.stats.braking;
            throttle = 0;
            this.braking = true;
        } else if (this.speed > cornerSpeed * 0.9) {
            // At corner speed: coast / light throttle
            throttle = 0.15 + this.stats.cornering * 0.1;
        } else {
            // Under corner speed: accelerate out
            throttle = Math.min(1.0, 0.4 + (1 - maxCurv) * 0.6);
        }

        // Off-track penalty
        if (this.offTrack) {
            throttle = Math.min(throttle, 0.3);
            brake = Math.max(brake, 0.2);
        }

        // ===== NEARBY CAR AWARENESS =====
        this.blocked = false;
        this.slipstreaming = false;
        this.overtakeTimer = Math.max(0, this.overtakeTimer - dt);
        this.defendTimer = Math.max(0, this.defendTimer - dt);

        let closestAhead = null;
        let closestAheadDot = Infinity;
        let closestBehind = null;
        let closestBehindDot = Infinity;

        for (const other of allCars) {
            if (other === this) continue;
            const dx = other.x - this.x, dy = other.y - this.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > 200) continue;

            const dotAhead = dx * Math.cos(this.angle) + dy * Math.sin(this.angle);
            const dotSide = -dx * Math.sin(this.angle) + dy * Math.cos(this.angle);
            const isTeammate = other.team === this.team;

            // Grace period: gentle avoidance only, no competition
            if (isGracePeriod) {
                if (dist < 60) {
                    if (dotAhead > 0 && dotAhead < 45) {
                        throttle = Math.min(throttle, 0.5);
                    }
                    if (Math.abs(dotSide) < 30 && dist < 45) {
                        if (dotSide > 0) steer = Math.min(steer, -0.15);
                        else steer = Math.max(steer, 0.15);
                    }
                }
                continue;
            }

            // Track nearest car ahead
            if (dotAhead > 0 && dotAhead < closestAheadDot && Math.abs(dotSide) < 40) {
                closestAheadDot = dotAhead;
                closestAhead = { car: other, dist, dotAhead, dotSide, isTeammate };
            }
            // Track nearest car behind
            if (dotAhead < 0 && -dotAhead < closestBehindDot && Math.abs(dotSide) < 40) {
                closestBehindDot = -dotAhead;
                closestBehind = { car: other, dist, dotAhead, dotSide, isTeammate };
            }

            // Slipstream detection: car ahead, nearly in line
            if (dotAhead > 40 && dotAhead < 130 && Math.abs(dotSide) < 25) {
                this.slipstreaming = true;
            }

            // Side-by-side avoidance: don't steer into adjacent car
            if (Math.abs(dotAhead) < 25 && Math.abs(dotSide) < 30 && dist < 42) {
                if (dotSide > 0) steer = Math.min(steer, -0.25);
                else steer = Math.max(steer, 0.25);
            }
        }

        // ===== OVERTAKING TACTICS =====
        if (closestAhead && !isGracePeriod) {
            const { car: ahead, dotAhead, dotSide, isTeammate } = closestAhead;

            if (dotAhead < 70 && Math.abs(dotSide) < 30) {
                this.blocked = true;

                if (isTeammate) {
                    // === TEAMMATE: cooperative, don't fight ===
                    if (dotAhead < 35) throttle = Math.min(throttle, 0.35);
                    else throttle = Math.min(throttle, 0.7);

                    // Only pass teammate if clearly faster (better lap time)
                    const isFaster = this.bestLapTime < ahead.bestLapTime * 0.98;
                    if (isFaster && this.overtakeTimer <= 0 && maxCurv < 0.05) {
                        this.targetLane = dotSide >= 0 ? -0.6 : 0.6;
                        this.overtakeTimer = 2.5;
                    }
                } else {
                    // === OPPONENT: tactical overtaking ===

                    // Speed management behind opponent
                    if (dotAhead < 30) {
                        throttle = Math.min(throttle, 0.2);
                        if (dotAhead < 20) brake = Math.max(brake, 0.35);
                    } else if (dotAhead < 50) {
                        throttle = Math.min(throttle, 0.55);
                    }

                    // Attempt overtake based on car strengths
                    if (this.overtakeTimer <= 0) {
                        let shouldOvertake = false;
                        let overtakeLane = dotSide >= 0 ? -0.85 : 0.85;

                        // On straights: speedsters and anyone with speed advantage
                        if (maxCurv < 0.05 && this.stats.aggression > 0.35) {
                            shouldOvertake = true;
                            // If slipstreaming, pull out to the side with more space
                            if (this.slipstreaming) {
                                overtakeLane = lateralOffset > 0 ? -0.85 : 0.85;
                            }
                        }

                        // Late braking: dive inside before corner
                        if (this.stats.braking > 1.05 && curvFar > 0.04 && maxCurv < 0.06) {
                            shouldOvertake = true;
                            const curvDir = this.getCurveDirection(nearIdx);
                            overtakeLane = -curvDir * 0.85; // inside of corner
                        }

                        // Aggressive/risky: attempt in moderate corners too
                        if (this.stats.aggression > 0.65 && maxCurv < 0.10) {
                            shouldOvertake = true;
                        }

                        // Cornering specialists: pass on corner exit
                        if (this.stats.cornering > 1.08 && curvNear > 0.04 && curvMid < 0.03) {
                            shouldOvertake = true;
                        }

                        if (shouldOvertake) {
                            this.targetLane = overtakeLane;
                            this.overtakeTimer = 1.2 + Math.random() * 1.0;
                        }
                    }
                }
            }
        }

        // ===== DEFENSIVE DRIVING =====
        if (closestBehind && !isGracePeriod && this.defendTimer <= 0 && this.overtakeTimer <= 0) {
            const { dotAhead, dotSide, isTeammate } = closestBehind;
            // Block opponents trying to pass (but never block teammates)
            if (!isTeammate && -dotAhead < 45 && this.stats.aggression > 0.4 && maxCurv < 0.06) {
                if (Math.abs(dotSide) > 12) {
                    // Move to cover the side they're approaching from
                    this.targetLane = dotSide > 0 ? 0.35 : -0.35;
                    this.defendTimer = 0.8;
                }
            }
        }

        // Return to racing line when no active maneuver
        if (!this.blocked && this.overtakeTimer <= 0 && this.defendTimer <= 0) {
            this.targetLane *= 0.94;
        }

        // Slipstream speed boost
        if (this.slipstreaming) {
            throttle = Math.min(1.0, throttle + 0.15);
        }

        return { throttle, brake, steer };
    }

    applyPhysics(throttle, brake, steer, dt) {
        const maxSpeed = 350 * this.stats.topSpeed;
        const accel = 220 * this.stats.accel;
        const brakeForce = 450 * this.stats.braking;
        const engineBrake = 30;
        const drag = 0.15;
        const steerRate = 3.0;

        // Engine / braking
        let force = throttle * accel - brake * brakeForce - engineBrake;
        force -= this.speed * drag;

        this.speed += force * dt;
        if (this.speed < 0) this.speed = 0;
        if (this.speed > maxSpeed) this.speed = maxSpeed;

        // Off-track friction
        if (this.offTrack) this.speed *= (1 - dt * 2.0);

        // Steering: less effective at very high speed
        const speedRatio = this.speed / maxSpeed;
        const steerFactor = steerRate * (1 - speedRatio * 0.35);
        this.angle += steer * steerFactor * dt;

        // Move
        this.x += Math.cos(this.angle) * this.speed * dt;
        this.y += Math.sin(this.angle) * this.speed * dt;

        // Hard boundary: push back onto track
        const closest = Track.closestPoint(this.x, this.y);
        const tw = Track.getWidth();
        const maxDist = tw * 0.52;
        if (closest.dist > maxDist) {
            const cpts = Track.getPoints();
            const ccp = cpts[closest.index];
            const dirX = this.x - ccp.x, dirY = this.y - ccp.y;
            const d = Math.sqrt(dirX * dirX + dirY * dirY);
            if (d > 0) {
                this.x = ccp.x + (dirX / d) * maxDist;
                this.y = ccp.y + (dirY / d) * maxDist;
            }
            this.speed *= 0.92;
        }
    }

    resolveCollisions(allCars) {
        for (const other of allCars) {
            if (other === this) continue;
            const dx = other.x - this.x, dy = other.y - this.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const minDist = this.collisionRadius + other.collisionRadius;

            if (dist < minDist && dist > 0.01) {
                const overlap = minDist - dist;
                const nx = dx / dist, ny = dy / dist;

                // Push apart
                const pushForce = overlap * 0.6;
                this.x -= nx * pushForce;
                this.y -= ny * pushForce;
                other.x += nx * pushForce;
                other.y += ny * pushForce;

                // Teammates: gentler collision (less speed loss, no sparks)
                const isTeammate = other.team === this.team;
                const speedKeep = isTeammate ? 0.97 : 0.92;
                const speedTransfer = isTeammate ? 0.02 : 0.05;

                const mySpeed = this.speed;
                const theirSpeed = other.speed;
                this.speed = mySpeed * speedKeep + theirSpeed * speedTransfer;
                other.speed = theirSpeed * speedKeep + mySpeed * speedTransfer;

                // Angle deflection
                const deflect = isTeammate ? 0.02 : 0.04;
                this.angle -= nx * deflect;
                other.angle += nx * deflect;

                if (!isTeammate) {
                    Effects.addSparks(
                        (this.x + other.x) / 2,
                        (this.y + other.y) / 2, 4
                    );
                }
            }
        }
    }

    /** Detect if car is stuck and push it forward. */
    detectStuck(dt) {
        const idxDiff = Math.abs(this.trackIndex - this.lastTrackIdx);
        if (idxDiff < 2 && this.speed < 10) {
            this.stuckTimer += dt;
            if (this.stuckTimer > 1.0) {
                // Unstick: teleport slightly forward on track
                const tn = Track.getPointCount();
                const newIdx = (this.trackIndex + 5) % tn;
                const pos = Track.getPositionAt(newIdx / tn, this.targetLane * 20);
                this.x = pos.x;
                this.y = pos.y;
                this.angle = pos.angle;
                this.speed = 80;
                this.stuckTimer = 0;
            }
        } else {
            this.stuckTimer = 0;
        }
        this.lastTrackIdx = this.trackIndex;
    }

    updateProgress(raceTime) {
        const tn = Track.getPointCount();
        const newProgress = this.trackIndex / tn;
        const delta = newProgress - this.progress;

        if (delta < -0.5) {
            this.lap++;
            const lapTime = raceTime - this.lapStartTime;
            if (lapTime > 2000) {
                this.lastLapTime = lapTime;
                this.lapTimes.push(lapTime);
                if (lapTime < this.bestLapTime) this.bestLapTime = lapTime;
            }
            this.lapStartTime = raceTime;
        }

        this.progress = newProgress;
        this.totalProgress = this.lap + this.progress;
        this.currentLapTime = raceTime - this.lapStartTime;
    }

    emitEffects(brakeAmount) {
        // Skid marks + tire smoke when braking hard
        if (this.braking && brakeAmount > 0.4 && this.speed > 60) {
            Effects.addSkidMark(this.x, this.y, this.angle, brakeAmount);
            if (brakeAmount > 0.6) {
                Effects.addTireSmoke(this.x, this.y, this.angle, brakeAmount);
            }
        }

        // Slipstream wind
        if (this.slipstreaming && this.speed > 100) {
            Effects.addSlipstreamLines(this.x, this.y, this.angle);
        }

        // Dirt when off track
        if (this.offTrack && this.speed > 30) {
            Effects.addDirt(this.x, this.y, this.angle);
        }
    }

    draw(ctx) {
        if (!this.image || !this.image.complete) return;

        ctx.save();
        ctx.translate(this.x, this.y);
        ctx.rotate(this.angle);

        // Car shadow
        ctx.save();
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.ellipse(2, 2, 20, 10, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        // Draw car at proper scale — 40x22px on screen
        const w = 40, h = 22;
        ctx.drawImage(this.image, -w/2, -h/2, w, h);

        // Brake lights
        if (this.braking) {
            ctx.fillStyle = 'rgba(255,0,0,0.7)';
            ctx.fillRect(-w/2 - 1, -4, 3, 3);
            ctx.fillRect(-w/2 - 1, 1, 3, 3);
        }

        // Position number above car
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(-6, -h/2 - 11, 12, 9);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 8px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`P${this.position}`, 0, -h/2 - 7);

        ctx.restore();
    }
}
