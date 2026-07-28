/**
 * Entry point: canvas sizing, the fixed-ish render loop, and wiring the
 * control room to the broadcast.
 *
 * The simulation itself always advances in fixed 1/60 s steps (see Sim); this
 * loop only decides *how many* steps to run for the wall-clock time that has
 * passed, which is what keeps a recorded race identical to a live one.
 */
(() => {
    const canvas = document.getElementById('trackCanvas');
    const ctx = canvas.getContext('2d');

    /** The track is pre-rendered at this multiple of world resolution so it
     *  still looks sharp when the broadcast camera zooms in. */
    const TRACK_SCALE = 2;

    let trackImage = null;
    let lastTimestamp = 0;
    let paused = true;          // stays paused behind the boot screen
    let world = { w: 1280, h: 720 };
    let booted = false;

    // -------------------------------------------------------------------------

    function sizeCanvas() {
        const vw = window.innerWidth || document.documentElement.clientWidth || 1280;
        const vh = window.innerHeight || document.documentElement.clientHeight || 720;
        canvas.width = Math.max(640, Math.round(vw));
        canvas.height = Math.max(400, Math.round(vh));
    }

    function rebuildTrackImage() {
        trackImage = document.createElement('canvas');
        trackImage.width = world.w * TRACK_SCALE;
        trackImage.height = world.h * TRACK_SCALE;
        const c = trackImage.getContext('2d');
        c.scale(TRACK_SCALE, TRACK_SCALE);
        drawBackground(c);
        Track.draw(c);
    }

    function drawBackground(c) {
        const w = world.w, h = world.h;

        const grad = c.createRadialGradient(w / 2, h / 2, 100, w / 2, h / 2, Math.max(w, h));
        grad.addColorStop(0, '#2d6b25');
        grad.addColorStop(1, '#173f12');
        c.fillStyle = grad;
        c.fillRect(0, 0, w, h);

        // Grass texture
        c.save();
        c.globalAlpha = 0.06;
        for (let i = 0; i < 2600; i++) {
            const gx = Math.random() * w;
            const gy = Math.random() * h;
            c.fillStyle = Math.random() > 0.5 ? '#194a12' : '#3d8a32';
            c.save();
            c.translate(gx, gy);
            c.rotate(Math.random() * Math.PI);
            c.fillRect(-3, 0, 6, 1);
            c.restore();
        }
        c.restore();

        // Gravel run-off on the outside of the quicker corners
        const pts = Track.getPoints();
        if (pts.length) {
            c.save();
            const tw = Track.getWidth();
            c.fillStyle = '#a89060';
            c.globalAlpha = 0.30;
            for (let i = 0; i < pts.length; i += 10) {
                const curv = Track.curvatureAt(i);
                if (curv <= 0.05) continue;
                const norm = Track.normalAt(i);
                for (const side of [1, -1]) {
                    const ox = pts[i].x + norm.x * (tw / 2 + 22) * side;
                    const oy = pts[i].y + norm.y * (tw / 2 + 22) * side;
                    c.beginPath();
                    c.arc(ox, oy, 12 + curv * 70, 0, Math.PI * 2);
                    c.fill();
                }
            }
            c.restore();
        }
    }

    // -------------------------------------------------------------------------

    function startRace(seed, laps) {
        world = { w: canvas.width, h: canvas.height };
        Race.setTotalLaps(laps);
        Race.init(seed, {
            worldW: world.w,
            worldH: world.h,
            totalLaps: laps,
            onTrackReady: () => {
                Effects.init(world.w, world.h);
                rebuildTrackImage();
                Hud.buildMinimap(210, 150);
            },
            onResults: () => Controls.onRaceResult(),
        });

        Camera.init(canvas.width, canvas.height, world);
        Hud.resize(canvas.width, canvas.height);
        Controls.setSeedLabel(seed, `${Track.getName()} · ${laps} laps`);

        const url = new URL(window.location.href);
        url.searchParams.set('seed', Rng.toCode(seed));
        url.searchParams.set('laps', String(laps));
        history.replaceState(null, '', url.toString());
    }

    function togglePause() {
        paused = !paused;
        Race.setPaused(paused);
        if (paused) Audio2.engineOff();
        return paused;
    }

    // -------------------------------------------------------------------------

    function loop(timestamp) {
        if (!lastTimestamp) lastTimestamp = timestamp;
        const dt = Math.min(timestamp - lastTimestamp, 60);
        lastTimestamp = timestamp;

        Race.update(dt);
        Editor.update(dt);

        const W = canvas.width, H = canvas.height;
        ctx.clearRect(0, 0, W, H);

        // ── World ──
        ctx.save();
        Camera.apply(ctx);
        if (trackImage) ctx.drawImage(trackImage, 0, 0, world.w, world.h);
        Editor.drawWorld(ctx);
        Race.drawWorld(ctx);
        ctx.restore();

        // ── Screen ──
        Race.drawScreen(ctx, W, H);
        Editor.drawPanel(ctx);

        requestAnimationFrame(loop);
    }

    // -------------------------------------------------------------------------

    function boot() {
        Commentary.init();

        const params = new URLSearchParams(window.location.search);
        const seedParam = params.get('seed');
        const lapsParam = parseInt(params.get('laps'), 10);
        const seed = seedParam ? Rng.fromCode(seedParam) : Rng.randomSeed();
        const laps = Number.isFinite(lapsParam) ? Math.max(3, Math.min(60, lapsParam)) : 14;

        document.getElementById('laps-input').value = laps;

        Controls.init({
            onNewRace: (s, l) => {
                paused = false;
                Race.setPaused(false);
                startRace(s, l);
                document.getElementById('btn-pause').textContent = '⏸ PAUSE';
            },
            onTogglePause: togglePause,
        });

        Editor.init(canvas, {
            onRebuildTrack: () => rebuildTrackImage(),
            onRestartRace: () => startRace(Race.getSeed(), Race.getTotalLaps()),
            onNewTrack: () => startRace(Rng.randomSeed(), Race.getTotalLaps()),
        });

        sizeCanvas();
        Hud.resize(canvas.width, canvas.height);
        startRace(seed, laps);
        Race.setPaused(true);

        requestAnimationFrame(loop);

        document.getElementById('boot-start').addEventListener('click', () => {
            if (booted) return;
            booted = true;
            Audio2.start();
            paused = false;
            Race.setPaused(false);
            document.getElementById('boot').classList.add('gone');
        });

        window.addEventListener('resize', () => {
            sizeCanvas();
            Camera.resize(canvas.width, canvas.height);
            Hud.resize(canvas.width, canvas.height);
            Hud.buildMinimap(210, 150);
        });
    }

    boot();
})();
