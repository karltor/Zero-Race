/**
 * Visual effects system: skid marks, slipstream trails, sparks, tire smoke.
 * Uses a persistent canvas layer for marks and particle arrays for transient FX.
 */
const Effects = (() => {
    let marksCanvas = null;  // persistent skid marks layer
    let marksCtx = null;
    const particles = [];    // transient particles [{x,y,vx,vy,life,maxLife,type,color,size}]
    const MAX_PARTICLES = 400;

    function init(w, h) {
        marksCanvas = document.createElement('canvas');
        marksCanvas.width = w;
        marksCanvas.height = h;
        marksCtx = marksCanvas.getContext('2d');
    }

    /** Add skid mark at position. Called each frame while braking hard. */
    function addSkidMark(x, y, angle, intensity) {
        if (!marksCtx) return;
        marksCtx.save();
        marksCtx.translate(x, y);
        marksCtx.rotate(angle);
        marksCtx.globalAlpha = Math.min(0.25, intensity * 0.15);
        marksCtx.fillStyle = '#222';
        // Two tire tracks
        marksCtx.fillRect(-3, -5, 6, 2);
        marksCtx.fillRect(-3, 3, 6, 2);
        marksCtx.restore();
    }

    /** Tire smoke puff when braking hard. */
    function addTireSmoke(x, y, angle, amount) {
        const count = Math.min(3, Math.ceil(amount * 2));
        for (let i = 0; i < count; i++) {
            if (particles.length >= MAX_PARTICLES) break;
            const spread = (Math.random() - 0.5) * 1.5;
            particles.push({
                x: x - Math.cos(angle) * 12 + spread * 5,
                y: y - Math.sin(angle) * 12 + spread * 5,
                vx: -Math.cos(angle) * (10 + Math.random() * 15) + (Math.random()-0.5) * 20,
                vy: -Math.sin(angle) * (10 + Math.random() * 15) + (Math.random()-0.5) * 20,
                life: 0.4 + Math.random() * 0.3,
                maxLife: 0.4 + Math.random() * 0.3,
                type: 'smoke',
                color: '#ccc',
                size: 3 + Math.random() * 4
            });
        }
    }

    /** Slipstream wind lines behind a car being drafted. */
    function addSlipstreamLines(x, y, angle) {
        if (particles.length >= MAX_PARTICLES) return;
        const backX = x - Math.cos(angle) * 25;
        const backY = y - Math.sin(angle) * 25;
        for (let i = 0; i < 2; i++) {
            const offset = (Math.random() - 0.5) * 14;
            const nx = -Math.sin(angle), ny = Math.cos(angle);
            particles.push({
                x: backX + nx * offset,
                y: backY + ny * offset,
                vx: -Math.cos(angle) * (40 + Math.random() * 30),
                vy: -Math.sin(angle) * (40 + Math.random() * 30),
                life: 0.2 + Math.random() * 0.15,
                maxLife: 0.3,
                type: 'wind',
                color: '#aaddff',
                size: 1 + Math.random()
            });
        }
    }

    /** Sparks when cars collide or scrape barriers. */
    function addSparks(x, y, count) {
        for (let i = 0; i < count && particles.length < MAX_PARTICLES; i++) {
            const a = Math.random() * Math.PI * 2;
            const spd = 50 + Math.random() * 100;
            particles.push({
                x, y,
                vx: Math.cos(a) * spd,
                vy: Math.sin(a) * spd,
                life: 0.15 + Math.random() * 0.2,
                maxLife: 0.3,
                type: 'spark',
                color: Math.random() > 0.5 ? '#ffaa00' : '#ffdd44',
                size: 1 + Math.random() * 1.5
            });
        }
    }

    /** Dirt spray when off-track. */
    function addDirt(x, y, angle) {
        if (particles.length >= MAX_PARTICLES) return;
        for (let i = 0; i < 2; i++) {
            particles.push({
                x: x + (Math.random()-0.5) * 8,
                y: y + (Math.random()-0.5) * 8,
                vx: -Math.cos(angle) * 20 + (Math.random()-0.5) * 30,
                vy: -Math.sin(angle) * 20 + (Math.random()-0.5) * 30,
                life: 0.3 + Math.random() * 0.2,
                maxLife: 0.5,
                type: 'dirt',
                color: '#8B7355',
                size: 2 + Math.random() * 3
            });
        }
    }

    function update(dt) {
        // Age and remove dead particles
        for (let i = particles.length - 1; i >= 0; i--) {
            const p = particles[i];
            p.life -= dt;
            if (p.life <= 0) {
                particles.splice(i, 1);
                continue;
            }
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            // Slow down
            p.vx *= (1 - dt * 3);
            p.vy *= (1 - dt * 3);
        }

        // Fade skid marks very slowly
        if (marksCtx && Math.random() < 0.02) {
            marksCtx.save();
            marksCtx.globalCompositeOperation = 'destination-out';
            marksCtx.globalAlpha = 0.005;
            marksCtx.fillRect(0, 0, marksCanvas.width, marksCanvas.height);
            marksCtx.restore();
        }
    }

    function draw(ctx) {
        // Skid marks layer
        if (marksCanvas) {
            ctx.drawImage(marksCanvas, 0, 0);
        }

        // Particles
        for (const p of particles) {
            const alpha = Math.min(1, p.life / p.maxLife);
            ctx.save();
            ctx.globalAlpha = alpha;

            if (p.type === 'smoke') {
                const expand = (1 - p.life / p.maxLife) * 2 + 1;
                ctx.fillStyle = p.color;
                ctx.globalAlpha = alpha * 0.3;
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.size * expand, 0, Math.PI * 2);
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
            }

            ctx.restore();
        }
    }

    function getMarksCanvas() { return marksCanvas; }

    return { init, addSkidMark, addTireSmoke, addSlipstreamLines,
        addSparks, addDirt, update, draw, getMarksCanvas };
})();
