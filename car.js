/**
 * Car with real 2D physics: position, velocity, steering, collisions.
 * AI drives using if/then/else logic for steering, throttle, braking.
 */
class Car {
    constructor(team, number) {
        this.team = team;
        this.number = number;
        this.name = `${team.charAt(0).toUpperCase() + team.slice(1)} #${number}`;
        this.image = CarSVG.getImage(team, number);

        // Physics state (world coordinates, pixels)
        this.x = 0;
        this.y = 0;
        this.angle = 0;       // radians, facing direction
        this.speed = 0;       // pixels/sec
        this.steerAngle = 0;  // current wheel angle

        // Car dimensions (in pixels for collision)
        this.width = 26;      // car body width
        this.length = 42;     // car body length
        this.collisionRadius = 16;

        // Per-driver traits (randomized)
        this.skillSpeed = 0;     // max speed multiplier
        this.skillBraking = 0;   // how early they brake
        this.skillLine = 0;      // how well they hit apex
        this.aggression = 0;     // overtaking tendency

        // Race tracking
        this.trackIndex = 0;     // closest track point index
        this.progress = 0;       // fractional [0..1)
        this.lap = 0;
        this.totalProgress = 0;
        this.position = 0;
        this.lapStartTime = 0;
        this.bestLapTime = Infinity;
        this.currentLapTime = 0;
        this.lastLapTime = 0;
        this.lapTimes = [];

        // AI state
        this.targetLane = 0;     // desired offset from center (-1 to 1)
        this.overtakeTimer = 0;
        this.blocked = false;

        this.init();
    }

    init() {
        this.skillSpeed = 0.92 + Math.random() * 0.08;
        this.skillBraking = 0.85 + Math.random() * 0.15;
        this.skillLine = 0.8 + Math.random() * 0.2;
        this.aggression = 0.3 + Math.random() * 0.7;
    }

    /** Place car at a track progress position with a lane offset in px. */
    placeOnTrack(progress, laneOffset) {
        this.progress = ((progress % 1) + 1) % 1;
        this.lap = 0;
        this.totalProgress = 0;
        this.speed = 0;
        this.steerAngle = 0;
        this.bestLapTime = Infinity;
        this.currentLapTime = 0;
        this.lastLapTime = 0;
        this.lapTimes = [];
        this.lapStartTime = 0;
        this.targetLane = laneOffset / (Track.getWidth() / 2);
        this.overtakeTimer = 0;

        const pos = Track.getPositionAt(this.progress, laneOffset);
        this.x = pos.x;
        this.y = pos.y;
        this.angle = pos.angle;
        this.trackIndex = Math.floor(this.progress * Track.getPointCount());
    }

    /**
     * Main update: AI decides inputs, then physics steps.
     * @param {number} dt - seconds (NOT ms)
     * @param {Car[]} allCars
     * @param {number} raceTime - ms
     */
    update(dt, allCars, raceTime) {
        if (this.lap === 0 && this.lapStartTime === 0) {
            this.lapStartTime = raceTime;
        }

        // --- AI DECISION MAKING ---
        const ai = this.computeAI(allCars, dt);

        // --- PHYSICS ---
        this.applyPhysics(ai.throttle, ai.brake, ai.steer, dt);

        // --- COLLISIONS ---
        this.handleCollisions(allCars);

        // --- TRACK PROGRESS ---
        this.updateProgress(raceTime);
    }

    computeAI(allCars, dt) {
        const n = Track.getPointCount();
        const tw = Track.getWidth();

        // Find where we are on track
        const closest = Track.closestPoint(this.x, this.y);
        this.trackIndex = closest.index;
        const trackAngle = Track.angleAt(this.trackIndex);

        // How far off-center am I?
        const norm = Track.normalAt(this.trackIndex);
        const pts = Track.getPoints();
        const cp = pts[this.trackIndex];
        const toCarX = this.x - cp.x, toCarY = this.y - cp.y;
        const lateralOffset = toCarX * norm.x + toCarY * norm.y;

        // Look ahead for curvature
        const lookDist = Math.max(10, Math.floor(this.speed * 0.08));
        const aheadIdx = (this.trackIndex + lookDist) % n;
        const curvAhead = Track.curvatureAt(aheadIdx);
        const curvNow = Track.curvatureAt(this.trackIndex);

        // Far look ahead for heavy braking zones
        const farLook = Math.max(20, Math.floor(this.speed * 0.15));
        const farIdx = (this.trackIndex + farLook) % n;
        const curvFar = Track.curvatureAt(farIdx);

        // --- STEERING ---
        // Target: stay on racing line (center + targetLane offset)
        const desiredOffset = this.targetLane * (tw * 0.35) * this.skillLine;
        const offsetError = desiredOffset - lateralOffset;

        // Angle error: difference between car heading and track direction
        let angleError = trackAngle - this.angle;
        while (angleError > Math.PI) angleError -= Math.PI * 2;
        while (angleError < -Math.PI) angleError += Math.PI * 2;

        // Combine: steer to correct both angle and position
        let steer = angleError * 3.0 + (offsetError / tw) * 2.5;
        steer = Math.max(-1, Math.min(1, steer));

        // --- THROTTLE & BRAKING ---
        const maxSpeed = 280 * this.skillSpeed; // px/sec
        let throttle = 0;
        let brake = 0;

        // Base: if going straight, full throttle
        if (curvNow < 0.04 && curvAhead < 0.06) {
            throttle = 1.0;
            brake = 0;
        }
        // Light curve: ease off throttle
        else if (curvAhead < 0.12) {
            const cornerSpeed = maxSpeed * (1 - curvAhead * 3);
            if (this.speed > cornerSpeed) {
                throttle = 0;
                brake = 0.3 * this.skillBraking;
            } else {
                throttle = 0.7;
            }
        }
        // Medium curve: brake and slow
        else if (curvAhead < 0.25) {
            const cornerSpeed = maxSpeed * (1 - curvAhead * 2.5);
            if (this.speed > cornerSpeed * 0.9) {
                throttle = 0;
                brake = 0.6 * this.skillBraking;
            } else {
                throttle = 0.5;
            }
        }
        // Tight curve: heavy braking
        else {
            const cornerSpeed = maxSpeed * 0.35;
            if (this.speed > cornerSpeed) {
                throttle = 0;
                brake = 0.85;
            } else {
                throttle = 0.3;
            }
        }

        // Pre-brake for upcoming heavy corner
        if (curvFar > 0.15 && this.speed > maxSpeed * 0.6) {
            brake = Math.max(brake, 0.3);
            throttle = Math.min(throttle, 0.3);
        }

        // If off track, steer back hard and slow down
        if (Math.abs(lateralOffset) > tw * 0.42) {
            throttle = 0.2;
            brake = 0.3;
        }

        // --- OVERTAKING AI ---
        this.blocked = false;
        this.overtakeTimer = Math.max(0, this.overtakeTimer - dt);

        for (const other of allCars) {
            if (other === this) continue;
            const dx = other.x - this.x, dy = other.y - this.y;
            const dist = Math.sqrt(dx*dx + dy*dy);

            if (dist > 120) continue;

            // Is the other car ahead of us in our direction?
            const dotAhead = dx * Math.cos(this.angle) + dy * Math.sin(this.angle);
            const dotSide = -dx * Math.sin(this.angle) + dy * Math.cos(this.angle);

            // Car is directly ahead and close
            if (dotAhead > 0 && dotAhead < 80 && Math.abs(dotSide) < 20) {
                this.blocked = true;

                // Slow down to avoid rear-ending
                if (dotAhead < 40) {
                    throttle = Math.min(throttle, 0.2);
                    brake = Math.max(brake, 0.4);
                } else {
                    throttle = Math.min(throttle, 0.5);
                }

                // Try to overtake if aggressive enough and timer allows
                if (this.overtakeTimer <= 0 && this.aggression > 0.4) {
                    // Pick a side to pass
                    if (dotSide > 0) {
                        this.targetLane = Math.max(-0.8, this.targetLane - 0.5);
                    } else {
                        this.targetLane = Math.min(0.8, this.targetLane + 0.5);
                    }
                    this.overtakeTimer = 1.5 + Math.random() * 2;
                }
            }

            // Avoid side contact: if car is beside us, don't steer into it
            if (Math.abs(dotAhead) < 30 && Math.abs(dotSide) < 25) {
                if (dotSide > 0) {
                    steer = Math.min(steer, 0);
                } else {
                    steer = Math.max(steer, 0);
                }
            }
        }

        // Gradually return to racing line when not overtaking
        if (!this.blocked && this.overtakeTimer <= 0) {
            this.targetLane *= 0.98;
        }

        return { throttle, brake, steer };
    }

    applyPhysics(throttle, brake, steer, dt) {
        const maxSpeed = 280 * this.skillSpeed;
        const accel = 180;      // px/s^2
        const brakeForce = 350;  // px/s^2
        const drag = 0.3;        // speed-proportional drag
        const steerRate = 2.8;   // rad/sec at max steer

        // Engine force
        const engineForce = throttle * accel;
        const brakeDecel = brake * brakeForce;

        // Speed change
        this.speed += (engineForce - brakeDecel - this.speed * drag) * dt;
        this.speed = Math.max(0, Math.min(maxSpeed, this.speed));

        // Steering: tighter at lower speeds, looser at high speed
        const steerFactor = steerRate * (1 - this.speed / maxSpeed * 0.4);
        this.angle += steer * steerFactor * dt;

        // Move
        this.x += Math.cos(this.angle) * this.speed * dt;
        this.y += Math.sin(this.angle) * this.speed * dt;

        // Track boundary enforcement
        const closest = Track.closestPoint(this.x, this.y);
        const tw = Track.getWidth();
        if (closest.dist > tw * 0.48) {
            // Push back onto track
            const pts = Track.getPoints();
            const cp = pts[closest.index];
            const norm = Track.normalAt(closest.index);
            const toCarX = this.x - cp.x, toCarY = this.y - cp.y;
            const latSign = (toCarX * norm.x + toCarY * norm.y) > 0 ? 1 : -1;

            const maxDist = tw * 0.48;
            this.x = cp.x + norm.x * maxDist * latSign;
            this.y = cp.y + norm.y * maxDist * latSign;
            this.speed *= 0.85; // friction penalty for hitting edge
        }
    }

    handleCollisions(allCars) {
        for (const other of allCars) {
            if (other === this) continue;
            const dx = other.x - this.x, dy = other.y - this.y;
            const dist = Math.sqrt(dx*dx + dy*dy);
            const minDist = this.collisionRadius + other.collisionRadius;

            if (dist < minDist && dist > 0.1) {
                // Push apart
                const overlap = minDist - dist;
                const nx = dx / dist, ny = dy / dist;
                this.x -= nx * overlap * 0.5;
                this.y -= ny * overlap * 0.5;
                other.x += nx * overlap * 0.5;
                other.y += ny * overlap * 0.5;

                // Exchange some speed (elastic-ish collision)
                const relVx = Math.cos(this.angle)*this.speed - Math.cos(other.angle)*other.speed;
                const relVy = Math.sin(this.angle)*this.speed - Math.sin(other.angle)*other.speed;
                const relDot = relVx * nx + relVy * ny;

                if (relDot > 0) {
                    this.speed *= 0.9;
                    other.speed *= 0.9;
                    // Slight angle deflection
                    this.angle -= nx * 0.05;
                    other.angle += nx * 0.05;
                }
            }
        }
    }

    updateProgress(raceTime) {
        const n = Track.getPointCount();
        const newProgress = this.trackIndex / n;

        // Detect lap crossing (progress wraps from ~1.0 back to ~0.0)
        const delta = newProgress - this.progress;
        if (delta < -0.5) {
            // Crossed the start line going forward
            this.lap++;
            const lapTime = raceTime - this.lapStartTime;
            if (lapTime > 1000) { // sanity: at least 1 second
                this.lastLapTime = lapTime;
                this.lapTimes.push(lapTime);
                if (lapTime < this.bestLapTime) {
                    this.bestLapTime = lapTime;
                }
            }
            this.lapStartTime = raceTime;
        }

        this.progress = newProgress;
        this.totalProgress = this.lap + this.progress;
        this.currentLapTime = raceTime - this.lapStartTime;
    }

    draw(ctx) {
        if (!this.image || !this.image.complete) return;

        ctx.save();
        ctx.translate(this.x, this.y);
        ctx.rotate(this.angle);

        // Draw car scaled to proper size
        const scale = 0.55;
        const w = 52 * scale, h = 28 * scale;
        ctx.drawImage(this.image, -w/2, -h/2, w, h);

        ctx.restore();
    }
}
