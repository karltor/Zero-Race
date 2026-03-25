/**
 * Main game loop and initialization.
 */
(() => {
    const canvas = document.getElementById('trackCanvas');
    const ctx = canvas.getContext('2d');
    const btnRestart = document.getElementById('btn-restart');

    let lastTimestamp = 0;
    let trackImage = null;

    function resize() {
        const container = canvas.parentElement;
        canvas.width = container.clientWidth - 320;
        canvas.height = container.clientHeight;
    }

    function initRace() {
        resize();
        Track.generate(canvas.width, canvas.height);
        Effects.init(canvas.width, canvas.height);
        Race.init();

        // Pre-render static track
        trackImage = document.createElement('canvas');
        trackImage.width = canvas.width;
        trackImage.height = canvas.height;
        const offCtx = trackImage.getContext('2d');
        drawBackground(offCtx);
        Track.draw(offCtx);

        lastTimestamp = 0;
        requestAnimationFrame(gameLoop);
    }

    function drawBackground(c) {
        const w = c.canvas.width, h = c.canvas.height;

        // Rich grass gradient
        const grad = c.createRadialGradient(w/2, h/2, 100, w/2, h/2, Math.max(w, h));
        grad.addColorStop(0, '#2d6b25');
        grad.addColorStop(1, '#1a4a15');
        c.fillStyle = grad;
        c.fillRect(0, 0, w, h);

        // Grass texture strokes
        c.save();
        c.globalAlpha = 0.06;
        for (let i = 0; i < 1200; i++) {
            const gx = Math.random() * w;
            const gy = Math.random() * h;
            c.fillStyle = Math.random() > 0.5 ? '#194a12' : '#3d8a32';
            const angle = Math.random() * Math.PI;
            c.save();
            c.translate(gx, gy);
            c.rotate(angle);
            c.fillRect(-3, 0, 6, 1);
            c.restore();
        }
        c.restore();

        // Gravel runoff areas
        const pts = Track.getPoints();
        if (pts.length > 0) {
            c.save();
            const tw = Track.getWidth();
            c.fillStyle = '#a89060';
            c.globalAlpha = 0.12;
            for (let i = 0; i < pts.length; i += 12) {
                const curv = Track.curvatureAt(i);
                if (curv > 0.05) {
                    const norm = Track.normalAt(i);
                    for (const side of [1, -1]) {
                        const ox = pts[i].x + norm.x * (tw/2 + 20) * side;
                        const oy = pts[i].y + norm.y * (tw/2 + 20) * side;
                        const size = 15 + curv * 120;
                        c.beginPath();
                        c.arc(ox, oy, size, 0, Math.PI * 2);
                        c.fill();
                    }
                }
            }
            c.restore();
        }
    }

    function gameLoop(timestamp) {
        if (lastTimestamp === 0) lastTimestamp = timestamp;
        const dt = Math.min(timestamp - lastTimestamp, 50);
        lastTimestamp = timestamp;

        Race.update(dt);

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (trackImage) ctx.drawImage(trackImage, 0, 0);

        Track.drawDebug(ctx);  // DEBUG: show control polygon + numbered points
        Race.draw(ctx);
        Sidebar.update(timestamp);

        requestAnimationFrame(gameLoop);
    }

    btnRestart.addEventListener('click', initRace);

    window.addEventListener('resize', () => {
        resize();
        trackImage = document.createElement('canvas');
        trackImage.width = canvas.width;
        trackImage.height = canvas.height;
        const offCtx = trackImage.getContext('2d');
        drawBackground(offCtx);
        Track.draw(offCtx);
        Effects.init(canvas.width, canvas.height);
    });

    initRace();
})();
