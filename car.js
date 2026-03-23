/**
 * Car with 2D physics and AI decision-making.
 * Physics: position, velocity, steering with proper integration.
 * AI: if/then/else for throttle, braking, steering, overtaking.
 */
class Car {
    constructor(team, number) {
        this.team = team;
        this.number = number;
        this.name = `${team.charAt(0).toUpperCase() + team.slice(1)} #${number}`;
        this.image = CarSVG.getImage(team, number);

        // Physics
        this.x = 0;
        this.y = 0;
        this.angle = 0;
        this.speed = 0;           // px/sec
        this.collisionRadius = 18;

        // Driver traits
        this.skillSpeed = 0.92 + Math.random() * 0.08;
        this.skillBraking = 0.85 + Math.random() * 0.15;
        this.skillLine = 0.8 + Math.random() * 0.2;
        this.aggression = 0.3 + Math.random() * 0.7;

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
        this.stuckTimer = 0;

        const pos = Track.getPositionAt(this.progress, laneOffset);
        this.x = pos.x;
        this.y = pos.y;
        this.angle = pos.angle;
        this.trackIndex = Math.floor(this.progress * Track.getPointCount());
        this.lastTrackIdx = this.trackIndex;
    }

    update(dt, allCars, raceTime) {
        if (this.lap === 0 && this.lapStartTime === 0) {
            this.lapStartTime = raceTime;
        }

        const ai = this.runAI(allCars, dt);
        this.applyPhysics(ai.throttle, ai.brake, ai.steer, dt);
        this.resolveCollisions(allCars);
        this.detectStuck(dt);
        this.updateProgress(raceTime);
        this.emitEffects(ai.brake);
    }

    runAI(allCars, dt) {
        const n = Track.getPointCount();
        const tw = Track.getWidth();
        const maxSpeed = 350 * this.skillSpeed;

        // Where am I on the track?
        const closest = Track.closestPoint(this.x, this.y);
        this.trackIndex = closest.index;
        const trackAngle = Track.angleAt(this.trackIndex);

        // Lateral position relative to center
        const norm = Track.normalAt(this.trackIndex);
        const pts = Track.getPoints();
        const cp = pts[this.trackIndex];
        const toCarX = this.x - cp.x, toCarY = this.y - cp.y;
        const lateralOffset = toCarX * norm.x + toCarY * norm.y;
        this.offTrack = Math.abs(lateralOffset) > tw * 0.45;

        // Curvature sampling at multiple distances
        const speedFactor = Math.max(1, this.speed / 50);
        const nearIdx = (this.trackIndex + Math.floor(8 * speedFactor)) % n;
        const midIdx = (this.trackIndex + Math.floor(18 * speedFactor)) % n;
        const farIdx = (this.trackIndex + Math.floor(35 * speedFactor)) % n;
        const curvNear = Track.curvatureAt(nearIdx);
        const curvMid = Track.curvatureAt(midIdx);
        const curvFar = Track.curvatureAt(farIdx);
        const maxCurv = Math.max(curvNear, curvMid * 0.8, curvFar * 0.5);

        // ===== STEERING =====
        const desiredOffset = this.targetLane * (tw * 0.3) * this.skillLine;
        const offsetError = desiredOffset - lateralOffset;

        let angleError = trackAngle - this.angle;
        while (angleError > Math.PI) angleError -= Math.PI * 2;
        while (angleError < -Math.PI) angleError += Math.PI * 2;

        // Stronger correction when off-line, gentler when on-line
        let steer = angleError * 2.5 + (offsetError / tw) * 3.0;

        // If very far off center, override with strong correction
        if (Math.abs(lateralOffset) > tw * 0.38) {
            steer = angleError * 4.0 + (offsetError / tw) * 5.0;
        }

        steer = Math.max(-1, Math.min(1, steer));

        // ===== THROTTLE & BRAKING =====
        let throttle = 0;
        let brake = 0;
        this.braking = false;

        // Corner speed calculation based on curvature
        const cornerSpeed = maxSpeed * Math.max(0.25, 1 - maxCurv * 4);

        if (maxCurv < 0.03) {
            // Straight: full power
            throttle = 1.0;
        } else if (this.speed > cornerSpeed * 1.05) {
            // Too fast for upcoming corner: brake
            const brakePower = Math.min(0.9, (this.speed - cornerSpeed) / cornerSpeed);
            brake = brakePower * this.skillBraking;
            throttle = 0;
            this.braking = true;
        } else if (this.speed > cornerSpeed * 0.9) {
            // At corner speed: coast
            throttle = 0.15;
        } else {
            // Under corner speed: accelerate
            throttle = Math.min(1.0, 0.4 + (1 - maxCurv) * 0.6);
        }

        // Off-track penalty: slow down, get back
        if (this.offTrack) {
            throttle = Math.min(throttle, 0.3);
            brake = Math.max(brake, 0.2);
        }

        // ===== OVERTAKING =====
        this.blocked = false;
        this.slipstreaming = false;
        this.overtakeTimer = Math.max(0, this.overtakeTimer - dt);

        for (const other of allCars) {
            if (other === this) continue;
            const dx = other.x - this.x, dy = other.y - this.y;
            const dist = Math.sqrt(dx*dx + dy*dy);
            if (dist > 150) continue;

            const dotAhead = dx * Math.cos(this.angle) + dy * Math.sin(this.angle);
            const dotSide = -dx * Math.sin(this.angle) + dy * Math.cos(this.angle);

            // Slipstream: car ahead within 50-120px, nearly aligned
            if (dotAhead > 40 && dotAhead < 120 && Math.abs(dotSide) < 25) {
                this.slipstreaming = true;
            }

            // Blocking: car ahead within 60px
            if (dotAhead > 5 && dotAhead < 60 && Math.abs(dotSide) < 22) {
                this.blocked = true;

                if (dotAhead < 35) {
                    // Very close: match their speed or brake
                    throttle = Math.min(throttle, 0.15);
                    if (dotAhead < 22) brake = Math.max(brake, 0.5);
                } else {
                    throttle = Math.min(throttle, 0.6);
                }

                // Decide to overtake
                if (this.overtakeTimer <= 0 && this.aggression > 0.3 && maxCurv < 0.12) {
                    this.targetLane = dotSide >= 0
                        ? Math.max(-0.85, this.targetLane - 0.6)
                        : Math.min(0.85, this.targetLane + 0.6);
                    this.overtakeTimer = 1.0 + Math.random() * 1.5;
                }
            }

            // Side avoidance: don't steer into adjacent car
            if (Math.abs(dotAhead) < 25 && Math.abs(dotSide) < 30 && dist < 40) {
                if (dotSide > 0) steer = Math.min(steer, -0.2);
                else steer = Math.max(steer, 0.2);
            }
        }

        // Return to racing line when clear
        if (!this.blocked && this.overtakeTimer <= 0) {
            this.targetLane *= 0.97;
        }

        // Slipstream speed boost
        if (this.slipstreaming) {
            throttle = Math.min(1.0, throttle + 0.15);
        }

        return { throttle, brake, steer };
    }

    applyPhysics(throttle, brake, steer, dt) {
        const maxSpeed = 350 * this.skillSpeed;
        const accel = 220;
        const brakeForce = 450;
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

        // Hard boundary: push back onto track, but not too aggressively
        const closest = Track.closestPoint(this.x, this.y);
        const tw = Track.getWidth();
        const maxDist = tw * 0.52;
        if (closest.dist > maxDist) {
            const pts = Track.getPoints();
            const cp = pts[closest.index];
            const dirX = this.x - cp.x, dirY = this.y - cp.y;
            const d = Math.sqrt(dirX*dirX + dirY*dirY);
            if (d > 0) {
                this.x = cp.x + (dirX/d) * maxDist;
                this.y = cp.y + (dirY/d) * maxDist;
            }
            this.speed *= 0.92;
        }
    }

    resolveCollisions(allCars) {
        for (const other of allCars) {
            if (other === this) continue;
            const dx = other.x - this.x, dy = other.y - this.y;
            const dist = Math.sqrt(dx*dx + dy*dy);
            const minDist = this.collisionRadius + other.collisionRadius;

            if (dist < minDist && dist > 0.01) {
                const overlap = minDist - dist;
                const nx = dx / dist, ny = dy / dist;

                // Push apart proportionally (heavier push to avoid sticking)
                const pushForce = overlap * 0.6;
                this.x -= nx * pushForce;
                this.y -= ny * pushForce;
                other.x += nx * pushForce;
                other.y += ny * pushForce;

                // Speed exchange: faster car slows less
                const myMomentum = this.speed;
                const theirMomentum = other.speed;
                this.speed = myMomentum * 0.92 + theirMomentum * 0.05;
                other.speed = theirMomentum * 0.92 + myMomentum * 0.05;

                // Small angle deflection away from each other
                this.angle -= nx * 0.04;
                other.angle += nx * 0.04;

                Effects.addSparks(
                    (this.x + other.x) / 2,
                    (this.y + other.y) / 2, 4
                );
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
                const n = Track.getPointCount();
                const newIdx = (this.trackIndex + 5) % n;
                const pos = Track.getPositionAt(newIdx / n, this.targetLane * 20);
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
        const n = Track.getPointCount();
        const newProgress = this.trackIndex / n;
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
