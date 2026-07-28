/**
 * Visual effects: skid marks, spray, smoke, sparks, weather overlay.
 *
 * Purely cosmetic — nothing in here feeds back into the simulation, so it is
 * free to use Math.random() and it is switched off entirely during headless
 * pre-simulation runs.
 */
const Effects = (() => {
    let marksCanvas = null;   // persistent skid-mark layer, in world coordinates
    let marksCtx = null;
    const particles = [];
    const MAX_PARTICLES = 900;
    let enabled = true;

    // Rain streaks live in screen space so they don't scale with the camera.
    const rainDrops = [];

    function init(w, h) {
        marksCanvas = document.createElement('canvas');
        marksCanvas.width = w;
        marksCanvas.height = h;
        marksCtx = marksCanvas.getContext('2d');
        particles.length = 0;
    }

    function setEnabled(v) { enabled = !!v; if (!v) particles.length = 0; }
    function isEnabled() { return enabled; }

    function clearMarks() {
        if (marksCtx) marksCtx.clearRect(0, 0, marksCanvas.width, marksCanvas.height);
    }

    function _push(p) {
        if (particles.length >= MAX_PARTICLES) return;
        particles.push(p);
    }

    function addSkidMark(x, y, angle, intensity) {
        if (!enabled || !marksCtx) return;
        marksCtx.save();
        marksCtx.translate(x, y);
        marksCtx.rotate(angle);
        marksCtx.globalAlpha = Math.min(0.25, intensity * 0.15);
        marksCtx.fillStyle = '#222';
        marksCtx.fillRect(-3, -5, 6, 2);
        marksCtx.fillRect(-3, 3, 6, 2);
        marksCtx.restore();
    }

    function addTireSmoke(x, y, angle, amount) {
        if (!enabled) return;
        const count = Math.min(3, Math.ceil(amount * 2));
        for (let i = 0; i < count; i++) {
            const spread = (Math.random() - 0.5) * 1.5;
            const smokeLife = 0.4 + Math.random() * 0.3;
            _push({
                x: x - Math.cos(angle) * 12 + spread * 5,
                y: y - Math.sin(angle) * 12 + spread * 5,
                vx: -Math.cos(angle) * (10 + Math.random() * 15) + (Math.random() - 0.5) * 20,
                vy: -Math.sin(angle) * (10 + Math.random() * 15) + (Math.random() - 0.5) * 20,
                life: smokeLife, maxLife: smokeLife,
                type: 'smoke', color: '#ccc', size: 3 + Math.random() * 4,
            });
        }
    }

    /** Rooster tail thrown up by a car running in the wet. */
    function addSpray(x, y, angle, wetness) {
        if (!enabled || Math.random() > wetness * 0.30) return;
        {
            const life = 0.30 + Math.random() * 0.28;
            _push({
                x: x - Math.cos(angle) * 16 + (Math.random() - 0.5) * 10,
                y: y - Math.sin(angle) * 16 + (Math.random() - 0.5) * 10,
                vx: -Math.cos(angle) * (30 + Math.random() * 45) + (Math.random() - 0.5) * 25,
                vy: -Math.sin(angle) * (30 + Math.random() * 45) + (Math.random() - 0.5) * 25,
                life, maxLife: life,
                type: 'spray', color: '#e8f4ff', size: 2 + Math.random() * 3,
            });
        }
    }

    /** Dark smoke from a damaged car. */
    function addSmokeTrail(x, y, damage) {
        if (!enabled || Math.random() > damage * 0.35) return;
        const life = 0.7 + Math.random() * 0.6;
        _push({
            x: x + (Math.random() - 0.5) * 8,
            y: y + (Math.random() - 0.5) * 8,
            vx: (Math.random() - 0.5) * 18,
            vy: (Math.random() - 0.5) * 18 - 8,
            life, maxLife: life,
            type: 'darksmoke', color: '#3a3a3a', size: 4 + Math.random() * 5,
        });
    }

    function addSlipstreamLines(x, y, angle) {
        if (!enabled) return;
        const backX = x - Math.cos(angle) * 25;
        const backY = y - Math.sin(angle) * 25;
        for (let i = 0; i < 2; i++) {
            const offset = (Math.random() - 0.5) * 14;
            const nx = -Math.sin(angle), ny = Math.cos(angle);
            _push({
                x: backX + nx * offset, y: backY + ny * offset,
                vx: -Math.cos(angle) * (40 + Math.random() * 30),
                vy: -Math.sin(angle) * (40 + Math.random() * 30),
                life: 0.2 + Math.random() * 0.15, maxLife: 0.3,
                type: 'wind', color: '#aaddff', size: 1 + Math.random(),
            });
        }
    }

    function addSparks(x, y, count) {
        if (!enabled) return;
        for (let i = 0; i < count; i++) {
            const a = Math.random() * Math.PI * 2;
            const spd = 50 + Math.random() * 100;
            _push({
                x, y, vx: Math.cos(a) * spd, vy: Math.sin(a) * spd,
                life: 0.15 + Math.random() * 0.2, maxLife: 0.3,
                type: 'spark', color: Math.random() > 0.5 ? '#ffaa00' : '#ffdd44',
                size: 1 + Math.random() * 1.5,
            });
        }
    }

    function addDirt(x, y, angle) {
        if (!enabled) return;
        for (let i = 0; i < 2; i++) {
            _push({
                x: x + (Math.random() - 0.5) * 8, y: y + (Math.random() - 0.5) * 8,
                vx: -Math.cos(angle) * 20 + (Math.random() - 0.5) * 30,
                vy: -Math.sin(angle) * 20 + (Math.random() - 0.5) * 30,
                life: 0.3 + Math.random() * 0.2, maxLife: 0.5,
                type: 'dirt', color: '#8B7355', size: 2 + Math.random() * 3,
            });
        }
    }

    /** Confetti burst for the chequered flag. */
    function addConfetti(x, y, count = 60) {
        if (!enabled) return;
        const colors = ['#ffd700', '#ff5c8a', '#4fe3ff', '#7CFC00', '#ffffff', '#ff8a3d'];
        for (let i = 0; i < count; i++) {
            const a = Math.random() * Math.PI * 2;
            const spd = 60 + Math.random() * 220;
            _push({
                x, y, vx: Math.cos(a) * spd, vy: Math.sin(a) * spd - 60,
                life: 1.4 + Math.random() * 1.4, maxLife: 2.6,
                type: 'confetti', color: colors[(Math.random() * colors.length) | 0],
                size: 2.5 + Math.random() * 3.5, spin: (Math.random() - 0.5) * 12, rot: Math.random() * 6.28,
            });
        }
    }

    function update(dt) {
        for (let i = particles.length - 1; i >= 0; i--) {
            const p = particles[i];
            p.life -= dt;
            if (p.life <= 0) { particles.splice(i, 1); continue; }
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            if (p.type === 'confetti') {
                p.vy += 120 * dt;
                p.rot += p.spin * dt;
                p.vx *= (1 - dt * 0.9);
            } else {
                p.vx *= (1 - dt * 3);
                p.vy *= (1 - dt * 3);
            }
        }

        // Skid marks fade very slowly; rain washes them away much faster.
        if (marksCtx && Math.random() < 0.02) {
            marksCtx.save();
            marksCtx.globalCompositeOperation = 'destination-out';
            marksCtx.globalAlpha = 0.005;
            marksCtx.fillRect(0, 0, marksCanvas.width, marksCanvas.height);
            marksCtx.restore();
        }
    }

    /** World-space draw — call inside the camera transform. */
    function draw(ctx) {
        if (marksCanvas) ctx.drawImage(marksCanvas, 0, 0);

        for (const p of particles) {
            const alpha = Math.min(1, p.life / p.maxLife);
            ctx.save();
            ctx.globalAlpha = alpha;

            if (p.type === 'smoke' || p.type === 'darksmoke') {
                const expand = (1 - p.life / p.maxLife) * 2 + 1;
                ctx.fillStyle = p.color;
                ctx.globalAlpha = alpha * (p.type === 'darksmoke' ? 0.42 : 0.20);
                ctx.beginPath();
                ctx.arc(p.x, p.y, Math.max(0.1, p.size * expand), 0, Math.PI * 2);
                ctx.fill();
            } else if (p.type === 'spray') {
                const expand = (1 - p.life / p.maxLife) * 1.6 + 1;
                ctx.fillStyle = p.color;
                ctx.globalAlpha = alpha * 0.14;
                ctx.beginPath();
                ctx.arc(p.x, p.y, Math.max(0.1, p.size * expand), 0, Math.PI * 2);
                ctx.fill();
            } else if (p.type === 'wind') {
                ctx.strokeStyle = p.color;
                ctx.globalAlpha = alpha * 0.4;
                ctx.lineWidth = p.size;
                ctx.beginPath();
                ctx.moveTo(p.x, p.y);
                ctx.lineTo(p.x - p.vx * 0.05, p.y - p.vy * 0.05);
                ctx.stroke();
            } else if (p.type === 'spark') {
                ctx.fillStyle = p.color;
                ctx.fillRect(p.x - 0.5, p.y - 0.5, p.size, p.size);
            } else if (p.type === 'dirt') {
                ctx.fillStyle = p.color;
                ctx.globalAlpha = alpha * 0.5;
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
                ctx.fill();
            } else if (p.type === 'confetti') {
                ctx.translate(p.x, p.y);
                ctx.rotate(p.rot);
                ctx.fillStyle = p.color;
                ctx.fillRect(-p.size / 2, -p.size, p.size, p.size * 2);
            }

            ctx.restore();
        }
    }

    // -------------------------------------------------------------------------
    // Weather overlay (screen space, drawn on top of everything)
    // -------------------------------------------------------------------------

    function drawWeather(ctx, wetness, rain, w, h, dt) {
        if (!enabled) return;
        if (wetness <= 0.02 && rain <= 0.02) return;

        // Cool, damp colour grade over the whole picture
        ctx.save();
        ctx.globalCompositeOperation = 'multiply';
        ctx.globalAlpha = Math.min(0.42, wetness * 0.42);
        ctx.fillStyle = '#7f96b8';
        ctx.fillRect(0, 0, w, h);
        ctx.restore();

        if (rain <= 0.03) return;

        const want = Math.floor(rain * 420);
        while (rainDrops.length < want) {
            rainDrops.push({
                x: Math.random() * w, y: Math.random() * h,
                len: 8 + Math.random() * 14, spd: 1100 + Math.random() * 800,
                drift: -160 - Math.random() * 90,
            });
        }
        while (rainDrops.length > want) rainDrops.pop();

        ctx.save();
        ctx.strokeStyle = 'rgba(200,225,255,0.30)';
        ctx.lineWidth = 0.9;
        ctx.beginPath();
        for (const d of rainDrops) {
            d.y += d.spd * dt;
            d.x += d.drift * dt;
            if (d.y > h) { d.y = -20; d.x = Math.random() * w; }
            if (d.x < -30) d.x = w + 20;
            ctx.moveTo(d.x, d.y);
            ctx.lineTo(d.x + d.drift * 0.012, d.y + d.len);
        }
        ctx.stroke();
        ctx.restore();
    }

    function getMarksCanvas() { return marksCanvas; }

    return {
        init, setEnabled, isEnabled, clearMarks,
        addSkidMark, addTireSmoke, addSpray, addSmokeTrail, addSlipstreamLines,
        addSparks, addDirt, addConfetti,
        update, draw, drawWeather, getMarksCanvas,
    };
})();
