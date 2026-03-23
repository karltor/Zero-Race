/**
 * Car physics and AI behavior for autonomous racing.
 */
class Car {
    constructor(team, number, laneOffset) {
        this.team = team;
        this.number = number;
        this.name = `${team.charAt(0).toUpperCase() + team.slice(1)} #${number}`;
        this.laneOffset = laneOffset;
        this.image = CarSVG.getImage(team, number);

        // Racing state
        this.progress = 0;           // 0..1 fraction around track per lap
        this.totalProgress = 0;      // cumulative progress (laps + fraction)
        this.lap = 0;
        this.speed = 0;
        this.maxSpeed = 0;
        this.baseMaxSpeed = 0;

        // Timing
        this.lapStartTime = 0;
        this.bestLapTime = Infinity;
        this.currentLapTime = 0;
        this.lastLapTime = 0;
        this.lapTimes = [];

        // AI characteristics (randomized per car)
        this.skill = 0;
        this.aggression = 0;
        this.consistency = 0;
        this.tireDeg = 0;

        // Dynamic state
        this.tireWear = 0;
        this.fuel = 1;
        this.slipstreaming = false;
        this.overtaking = false;

        // Position tracking
        this.x = 0;
        this.y = 0;
        this.angle = 0;
        this.position = 0;          // race position 1-8

        this.init();
    }

    init() {
        // Randomize driver characteristics
        this.skill = 0.85 + Math.random() * 0.15;
        this.aggression = 0.3 + Math.random() * 0.7;
        this.consistency = 0.9 + Math.random() * 0.1;
        this.tireDeg = 0.0001 + Math.random() * 0.0002;

        // Base speed varies by skill
        this.baseMaxSpeed = (0.0012 + this.skill * 0.0004) * (0.95 + Math.random() * 0.1);
        this.maxSpeed = this.baseMaxSpeed;
    }

    reset(startProgress) {
        this.progress = startProgress;
        this.totalProgress = 0;
        this.lap = 0;
        this.speed = 0;
        this.maxSpeed = this.baseMaxSpeed;
        this.tireWear = 0;
        this.fuel = 1;
        this.bestLapTime = Infinity;
        this.currentLapTime = 0;
        this.lastLapTime = 0;
        this.lapTimes = [];
        this.lapStartTime = 0;
        this.slipstreaming = false;
    }

    /**
     * Update car for one frame.
     * @param {number} dt - delta time in ms
     * @param {Car[]} allCars - all cars for interaction
     * @param {number} raceTime - current race time in ms
     */
    update(dt, allCars, raceTime) {
        if (this.lap === 0 && this.lapStartTime === 0) {
            this.lapStartTime = raceTime;
        }

        // Current track curvature affects speed
        const curvature = this.getCurvature();
        const curveSlowdown = 1 - curvature * (1.2 - this.skill * 0.4);

        // Tire degradation
        this.tireWear += this.tireDeg * dt * (1 + curvature * 2);
        const tireMultiplier = 1 - this.tireWear * 0.15;

        // Fuel effect (lighter = faster over time)
        this.fuel = Math.max(0.3, this.fuel - 0.000001 * dt);
        const fuelMultiplier = 1 + (1 - this.fuel) * 0.02;

        // Consistency wobble
        const wobble = (Math.sin(raceTime * 0.001 * this.number + this.progress * 50) *
            (1 - this.consistency) * 0.05);

        // Slipstream detection
        this.slipstreaming = false;
        for (const other of allCars) {
            if (other === this) continue;
            const dist = this.distanceTo(other);
            if (dist > 0 && dist < 0.015 && Math.abs(this.laneOffset - other.laneOffset) < 15) {
                this.slipstreaming = true;
                break;
            }
        }
        const slipBoost = this.slipstreaming ? 1.06 : 1;

        // Calculate target speed
        const targetSpeed = this.baseMaxSpeed * curveSlowdown * tireMultiplier *
            fuelMultiplier * slipBoost * (1 + wobble);

        // Smooth acceleration/braking
        const accelRate = curvature > 0.3 ? 0.003 : 0.002;
        if (this.speed < targetSpeed) {
            this.speed += accelRate * dt * this.skill;
        } else {
            this.speed -= accelRate * dt * 1.5;
        }
        this.speed = Math.max(0.0001, this.speed);

        // Avoidance: slow down if very close to car ahead
        for (const other of allCars) {
            if (other === this) continue;
            const dist = this.distanceTo(other);
            if (dist > 0 && dist < 0.008 &&
                Math.abs(this.laneOffset - other.laneOffset) < 10) {
                this.speed *= 0.97;
                // Try to overtake by shifting lane
                if (this.aggression > 0.5 && Math.random() < 0.02) {
                    this.laneOffset += (Math.random() > 0.5 ? 1 : -1) *
                        (5 + Math.random() * 8);
                    this.laneOffset = Math.max(-18, Math.min(18, this.laneOffset));
                }
            }
        }

        // Gradually return to ideal racing line
        const idealLane = this.getIdealLane(curvature);
        this.laneOffset += (idealLane - this.laneOffset) * 0.002 * dt;

        // Update position
        const prevProgress = this.progress;
        this.progress += this.speed * dt;
        this.totalProgress += this.speed * dt;

        // Lap crossing detection
        if (this.progress >= 1) {
            this.progress -= 1;
            this.lap++;
            const lapTime = raceTime - this.lapStartTime;
            if (this.lap > 1 || this.lapStartTime > 0) {
                this.lastLapTime = lapTime;
                this.lapTimes.push(lapTime);
                if (lapTime < this.bestLapTime) {
                    this.bestLapTime = lapTime;
                }
            }
            this.lapStartTime = raceTime;
        }

        this.currentLapTime = raceTime - this.lapStartTime;

        // Get visual position
        const pos = Track.getPositionAt(this.progress, this.laneOffset);
        this.x = pos.x;
        this.y = pos.y;
        this.angle = pos.angle;
    }

    getCurvature() {
        const pts = Track.getPoints();
        const n = pts.length;
        const idx = Math.floor((this.progress % 1) * n);
        const lookAhead = 5;

        const p0 = pts[(idx - lookAhead + n) % n];
        const p1 = pts[idx];
        const p2 = pts[(idx + lookAhead) % n];

        const dx1 = p1.x - p0.x, dy1 = p1.y - p0.y;
        const dx2 = p2.x - p1.x, dy2 = p2.y - p1.y;
        const cross = Math.abs(dx1 * dy2 - dy1 * dx2);
        const len = Math.sqrt(dx1 * dx1 + dy1 * dy1) * Math.sqrt(dx2 * dx2 + dy2 * dy2);

        return len > 0 ? Math.min(1, cross / len) : 0;
    }

    getIdealLane(curvature) {
        // Skilled drivers take tighter lines on curves
        const pts = Track.getPoints();
        const n = pts.length;
        const idx = Math.floor((this.progress % 1) * n);
        const lookAhead = 10;

        const p1 = pts[idx];
        const p2 = pts[(idx + lookAhead) % n];
        const dx = p2.x - p1.x, dy = p2.y - p1.y;
        const norm = Track.normalAt(idx);
        const side = dx * norm.y - dy * norm.x;

        return side > 0 ? -curvature * 8 * this.skill : curvature * 8 * this.skill;
    }

    distanceTo(other) {
        let diff = other.progress - this.progress;
        if (diff < -0.5) diff += 1;
        if (diff > 0.5) diff -= 1;
        return diff;
    }

    draw(ctx) {
        if (!this.image || !this.image.complete) return;

        ctx.save();
        ctx.translate(this.x, this.y);
        ctx.rotate(this.angle);

        // Draw slipstream effect
        if (this.slipstreaming) {
            ctx.save();
            ctx.globalAlpha = 0.15;
            for (let i = 1; i <= 3; i++) {
                ctx.fillStyle = '#aaddff';
                ctx.beginPath();
                ctx.ellipse(-20 - i * 8, 0, 4 + i * 2, 8 + i * 2, 0, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.restore();
        }

        // Car image (centered)
        const w = 52, h = 28;
        ctx.drawImage(this.image, -w / 2, -h / 2, w, h);

        ctx.restore();
    }
}
