/**
 * Broadcast camera.
 *
 * A static wide shot of the whole circuit is the single biggest reason the old
 * build was boring to watch: eight ants going round in circles. This module
 * acts like a TV director instead — it scores every battle on track, cuts to
 * the best one, holds the shot long enough to read, and cuts away when
 * something better happens.
 */
const Camera = (() => {

    const MIN_SHOT   = 3.4;    // seconds before we're allowed to cut again
    const MAX_SHOT   = 9.0;    // seconds before we look for something new
    const ZOOM_MAX   = 3.1;
    const PAD        = 190;    // world px of breathing room around the subject

    let viewW = 1280, viewH = 720;
    let worldW = 1280, worldH = 720;
    let minZoom = 1;

    const cam    = { x: 640, y: 360, zoom: 1 };
    const target = { x: 640, y: 360, zoom: 1 };

    let mode = 'wide';           // wide | action | spotlight
    let subjects = [];
    let shotTime = 0;
    let spotlightTimer = 0;
    let shakeAmp = 0, shakeT = 0;
    let cutFlash = 0;
    let enabled = true;

    function init(vw, vh, world) {
        viewW = vw; viewH = vh;
        worldW = world ? world.w : vw;
        worldH = world ? world.h : vh;
        minZoom = Math.min(viewW / worldW, viewH / worldH);
        cam.x = target.x = worldW / 2;
        cam.y = target.y = worldH / 2;
        cam.zoom = target.zoom = minZoom;
        mode = 'wide';
        subjects = [];
        shotTime = 0;
        spotlightTimer = 0;
    }

    /** Window resize — keep the current shot, just re-fit the viewport. */
    function resize(vw, vh) {
        viewW = vw; viewH = vh;
        minZoom = Math.min(viewW / worldW, viewH / worldH);
        _clamp();
    }

    function setEnabled(v) { enabled = v; if (!enabled) goWide(); }
    function isEnabled() { return enabled; }

    function goWide() {
        mode = 'wide';
        subjects = [];
        target.x = worldW / 2;
        target.y = worldH / 2;
        target.zoom = minZoom;
    }

    /** Force the camera onto a car for a few seconds (used when a big event fires). */
    function spotlight(cars, seconds = 4.5) {
        if (!enabled) return;
        const list = Array.isArray(cars) ? cars.filter(Boolean) : [cars].filter(Boolean);
        if (!list.length) return;
        subjects = list;
        mode = 'spotlight';
        spotlightTimer = seconds;
        shotTime = 0;
        cutFlash = 1;
        _snapToSubjects(true);
    }

    function shake(amount) { shakeAmp = Math.min(22, shakeAmp + amount); shakeT = 0; }

    // -------------------------------------------------------------------------

    /**
     * @param {number} dt seconds
     * @param {object} ctx { order, cars, phase, safetyCar, leader, wide }
     */
    function update(dt, ctx) {
        shotTime += dt;
        if (spotlightTimer > 0) spotlightTimer -= dt;

        if (!enabled || ctx.wide) {
            goWide();
        } else if (ctx.phase === 'grid' || ctx.phase === 'countdown') {
            // Hold on the front row before the start.
            const front = (ctx.order || []).slice(0, 3);
            if (front.length) { subjects = front; mode = 'action'; }
        } else if (spotlightTimer <= 0 && ctx.phase === 'race') {
            if (shotTime > MIN_SHOT) _pickShot(ctx);
        }

        if (mode !== 'wide') _snapToSubjects(false);

        // Smooth follow; the cut itself is instantaneous (see _snapToSubjects).
        const k = Math.min(1, dt * 3.2);
        cam.x += (target.x - cam.x) * k;
        cam.y += (target.y - cam.y) * k;
        cam.zoom += (target.zoom - cam.zoom) * Math.min(1, dt * 2.4);

        _clamp();

        if (shakeAmp > 0.05) {
            shakeT += dt;
            shakeAmp *= (1 - Math.min(1, dt * 4.5));
        } else shakeAmp = 0;

        if (cutFlash > 0) cutFlash = Math.max(0, cutFlash - dt * 4);
    }

    /** Score the field and cut to the best story on track. */
    function _pickShot(ctx) {
        const order = (ctx.order || []).filter(c => !c.retired);
        if (order.length < 2) { goWide(); return; }

        let best = null, bestScore = -Infinity;

        for (let i = 0; i < order.length - 1; i++) {
            const a = order[i], b = order[i + 1];
            if (a.inPitLane || b.inPitLane) continue;
            const gap = Number.isFinite(b.gapAheadSec) ? b.gapAheadSec : 99;

            let score = 0;
            score += Math.max(0, 3.0 - gap) * 9;         // closeness is everything
            score += Math.max(0, 9 - a.position) * 2.2;  // the sharp end matters more
            if (a.position === 1) score += 10;
            if (b.drsActive) score += 7;
            if (b.boostTimer > 0) score += 5;
            if (a.braking && b.braking) score += 2;
            if (b.spinTimer > 0 || a.spinTimer > 0) score += 25;
            // Don't sit on the same shot forever.
            if (subjects.includes(a) && subjects.includes(b)) score += (shotTime > MAX_SHOT ? -14 : 6);

            if (score > bestScore) { bestScore = score; best = [a, b]; }
        }

        // Nothing close anywhere: follow the leader, but pulled back.
        if (!best || bestScore < 8) {
            const lead = order[0];
            if (!lead) { goWide(); return; }
            const changed = !(subjects.length === 1 && subjects[0] === lead);
            subjects = [lead];
            mode = 'action';
            if (changed) { shotTime = 0; cutFlash = 0.7; _snapToSubjects(true); }
            return;
        }

        const same = subjects.length === best.length && best.every(c => subjects.includes(c));
        if (!same) {
            subjects = best;
            mode = 'action';
            shotTime = 0;
            cutFlash = 0.8;
            _snapToSubjects(true);
        }
    }

    function _snapToSubjects(hardCut) {
        if (!subjects.length) return;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const c of subjects) {
            if (c.x < minX) minX = c.x;
            if (c.y < minY) minY = c.y;
            if (c.x > maxX) maxX = c.x;
            if (c.y > maxY) maxY = c.y;
        }
        const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
        const w = (maxX - minX) + PAD * 2;
        const h = (maxY - minY) + PAD * 2;
        const z = Math.max(minZoom, Math.min(ZOOM_MAX, Math.min(viewW / w, viewH / h)));

        target.x = cx; target.y = cy; target.zoom = z;

        if (hardCut) {
            cam.x = cx; cam.y = cy; cam.zoom = z;
            _clamp();
        }
    }

    function _clamp() {
        cam.zoom = Math.max(minZoom * 0.999, Math.min(ZOOM_MAX, cam.zoom));
        const halfW = viewW / (2 * cam.zoom);
        const halfH = viewH / (2 * cam.zoom);
        if (worldW * cam.zoom <= viewW) cam.x = worldW / 2;
        else cam.x = Math.max(halfW, Math.min(worldW - halfW, cam.x));
        if (worldH * cam.zoom <= viewH) cam.y = worldH / 2;
        else cam.y = Math.max(halfH, Math.min(worldH - halfH, cam.y));
    }

    // -------------------------------------------------------------------------

    function apply(ctx2d) {
        const sx = shakeAmp > 0 ? Math.sin(shakeT * 61) * shakeAmp : 0;
        const sy = shakeAmp > 0 ? Math.cos(shakeT * 47) * shakeAmp : 0;
        ctx2d.translate(viewW / 2 + sx, viewH / 2 + sy);
        ctx2d.scale(cam.zoom, cam.zoom);
        ctx2d.translate(-cam.x, -cam.y);
    }

    function screenToWorld(sx, sy) {
        return {
            x: (sx - viewW / 2) / cam.zoom + cam.x,
            y: (sy - viewH / 2) / cam.zoom + cam.y,
        };
    }

    function worldToScreen(wx, wy) {
        return {
            x: (wx - cam.x) * cam.zoom + viewW / 2,
            y: (wy - cam.y) * cam.zoom + viewH / 2,
        };
    }

    function getZoom()      { return cam.zoom; }
    function getSubjects()  { return subjects; }
    function getCutFlash()  { return cutFlash; }
    function getMode()      { return mode; }

    return {
        init, resize, update, apply, screenToWorld, worldToScreen,
        spotlight, shake, goWide, setEnabled, isEnabled,
        getZoom, getSubjects, getCutFlash, getMode,
    };
})();
