/**
 * Main game loop and initialization.
 */
(() => {
    const canvas = document.getElementById('trackCanvas');
    const ctx = canvas.getContext('2d');
    const btnRestart = document.getElementById('btn-restart');
    const btnSpeed = document.getElementById('btn-speed');

    let lastTimestamp = 0;
    let trackImage = null; // offscreen canvas for static track

    function resize() {
        const container = canvas.parentElement;
        canvas.width = container.clientWidth - 280; // sidebar width
        canvas.height = container.clientHeight;
    }

    function initRace() {
        resize();
        Track.generate(canvas.width, canvas.height);
        Race.init();

        // Pre-render track to offscreen canvas
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
        // Grass base
        c.fillStyle = '#2d5a27';
        c.fillRect(0, 0, c.canvas.width, c.canvas.height);

        // Grass texture
        c.save();
        c.globalAlpha = 0.08;
        for (let i = 0; i < 800; i++) {
            const gx = Math.random() * c.canvas.width;
            const gy = Math.random() * c.canvas.height;
            c.fillStyle = Math.random() > 0.5 ? '#1a4a15' : '#3d7a35';
            c.fillRect(gx, gy, 2 + Math.random() * 3, 1);
        }
        c.restore();

        // Gravel traps (around some track areas)
        const pts = Track.getPoints();
        if (pts.length > 0) {
            c.save();
            c.globalAlpha = 0.15;
            c.fillStyle = '#c4a86a';
            for (let i = 0; i < pts.length; i += 20) {
                const norm = Track.normalAt(i);
                const tw = Track.getWidth();
                for (const side of [1, -1]) {
                    const ox = pts[i].x + norm.x * (tw / 2 + 15) * side;
                    const oy = pts[i].y + norm.y * (tw / 2 + 15) * side;
                    c.beginPath();
                    c.arc(ox, oy, 12 + Math.random() * 8, 0, Math.PI * 2);
                    c.fill();
                }
            }
            c.restore();
        }
    }

    function gameLoop(timestamp) {
        if (lastTimestamp === 0) lastTimestamp = timestamp;
        const dt = Math.min(timestamp - lastTimestamp, 50); // cap at 50ms
        lastTimestamp = timestamp;

        // Update
        Race.update(dt);

        // Draw
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Static track from cache
        if (trackImage) {
            ctx.drawImage(trackImage, 0, 0);
        }

        // Cars and overlays
        Race.draw(ctx);

        // Sidebar
        Sidebar.update(timestamp);

        requestAnimationFrame(gameLoop);
    }

    // Controls
    btnRestart.addEventListener('click', () => {
        initRace();
    });

    const speeds = [1, 2, 4, 8];
    let speedIdx = 0;
    btnSpeed.addEventListener('click', () => {
        speedIdx = (speedIdx + 1) % speeds.length;
        Race.setSpeed(speeds[speedIdx]);
        btnSpeed.textContent = `SPEED: ${speeds[speedIdx]}x`;
    });

    window.addEventListener('resize', () => {
        resize();
        // Regenerate track on resize
        Track.generate(canvas.width, canvas.height);
        trackImage = document.createElement('canvas');
        trackImage.width = canvas.width;
        trackImage.height = canvas.height;
        const offCtx = trackImage.getContext('2d');
        drawBackground(offCtx);
        Track.draw(offCtx);
    });

    // Start!
    initRace();
})();
