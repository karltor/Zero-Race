/**
 * Broadcast camera — planned, not reactive.
 *
 * The first version cut to every overtake it saw, and with forty passes in a
 * race that reads as a strobe light. This one uses the fact that the whole
 * race is already simulated: before a frame is drawn, `buildPlan()` picks the
 * handful of moments worth a close-up and schedules them.
 *
 * The resting state is the full-circuit wide shot. For a planned moment the
 * camera eases *in ahead of the event* (it knows when it is coming, exactly
 * like a real director with a camera operator already standing in the corner),
 * holds through it, then eases back out to the wide shot.
 *
 * The result is: wide → glide in → beat → glide out → wide.
 */
const Camera = (() => {

    const ZOOM_MAX  = 2.9;
    const PAD       = 210;    // world px of breathing room around the subject

    // Shot timing, in seconds.
    const LEAD_IN   = 1.7;    // ease in before the moment lands
    const HOLD_BASE = 2.6;    // dwell on the action
    const LEAD_OUT  = 1.5;    // ease back out to the wide shot
    const MIN_GAP   = 3.5;    // quiet wide-shot time between two close-ups

    let viewW = 1280, viewH = 720;
    let worldW = 1280, worldH = 720;
    let minZoom = 1;

    const cam    = { x: 640, y: 360, zoom: 1 };
    let enabled  = true;

    let plan = [];            // scheduled shots, sorted by start time
    let planIdx = 0;
    let activeShot = null;
    let blend = 0;            // 0 = wide, 1 = fully on the subject
    let subjects = [];
    let shotLabel = '';

    let shakeAmp = 0, shakeT = 0;
    let manualTimer = 0;      // legacy spotlight override

    // -------------------------------------------------------------------------

    function init(vw, vh, world) {
        viewW = vw; viewH = vh;
        worldW = world ? world.w : vw;
        worldH = world ? world.h : vh;
        minZoom = Math.min(viewW / worldW, viewH / worldH);
        cam.x = worldW / 2;
        cam.y = worldH / 2;
        cam.zoom = minZoom;
        plan = [];
        planIdx = 0;
        activeShot = null;
        blend = 0;
        subjects = [];
        shotLabel = '';
    }

    function resize(vw, vh) {
        viewW = vw; viewH = vh;
        minZoom = Math.min(viewW / worldW, viewH / worldH);
        _clamp();
    }

    function setEnabled(v) {
        enabled = v;
        if (!enabled) { activeShot = null; subjects = []; blend = 0; }
    }
    function isEnabled() { return enabled; }

    // -------------------------------------------------------------------------
    // Planning
    // -------------------------------------------------------------------------

    /** How long to dwell on a moment, given how big it is. */
    function _holdFor(e) {
        if (e.type === 'chequered' || e.type === 'dnf') return 4.6;
        if (e.type === 'sc_deploy' || e.type === 'crash') return 3.6;
        if (e.type === 'pit_enter' || e.type === 'pit_exit') return 3.4;
        if (e.significance > 95) return 3.8;
        return HOLD_BASE;
    }

    /** Caption for the shot, so the viewer knows why we're looking here. */
    function _labelFor(e) {
        const d = e.data || {};
        switch (e.type) {
            case 'overtake':    return d.position === 1 ? 'FOR THE LEAD' : `BATTLE FOR P${d.position}`;
            case 'lead_change': return 'FOR THE LEAD';
            case 'battle':      return `BATTLE FOR P${d.position}`;
            case 'pit_enter':   return 'PIT STOP';
            case 'pit_exit':    return 'OUT OF THE PITS';
            case 'crash':
            case 'contact':     return 'CONTACT';
            case 'spin':        return 'SPIN';
            case 'dnf':         return 'RETIREMENT';
            case 'chequered':   return 'THE FINISH';
            case 'fastest_lap': return 'FASTEST LAP';
            default:            return '';
        }
    }

    /** Which cars a shot should frame. */
    function _carsFor(e) {
        const d = e.data || {};
        return [d.carId, d.victimId, d.otherId, d.aheadId].filter(Boolean);
    }

    /**
     * Choose the moments worth a close-up.
     *
     * Greedy by significance: take the biggest story first, then the next one
     * that doesn't overlap a shot we already scheduled. That guarantees the
     * camera never cuts more than roughly once every ten seconds, and that the
     * shots it does take are the ones that matter.
     *
     * @param {Array}  events analysed log from Sim.runHeadless()
     * @param {number} duration race length in ms
     */
    function buildPlan(events, duration) {
        const WORTH_A_SHOT = new Set([
            'overtake', 'lead_change', 'crash', 'spin', 'dnf', 'chequered',
            'pit_enter', 'pit_exit', 'battle', 'sc_deploy', 'mech_issue',
        ]);

        const candidates = events
            .filter(e => WORTH_A_SHOT.has(e.type) && _carsFor(e).length)
            .slice()
            .sort((a, b) => b.significance - a.significance);

        const chosen = [];
        for (const e of candidates) {
            const hold = _holdFor(e);
            const start = e.t / 1000 - LEAD_IN;
            const done = e.t / 1000 + hold + LEAD_OUT;
            if (start < 1.0) continue;                     // never cut over the start itself

            const clash = chosen.some(s => start < s.done + MIN_GAP && done + MIN_GAP > s.start);
            if (clash) continue;

            chosen.push({
                start,
                peak: e.t / 1000,
                end: e.t / 1000 + hold,
                done,
                carIds: _carsFor(e),
                label: _labelFor(e),
                type: e.type,
                significance: e.significance,
            });
        }

        chosen.sort((a, b) => a.start - b.start);
        plan = chosen;
        planIdx = 0;
        activeShot = null;
        blend = 0;
        subjects = [];
        return plan;
    }

    function getPlan() { return plan; }

    /** Restart playback of an already-built plan. */
    function rewind() {
        planIdx = 0;
        activeShot = null;
        blend = 0;
        subjects = [];
        shotLabel = '';
    }

    // -------------------------------------------------------------------------
    // Playback
    // -------------------------------------------------------------------------

    function smoothstep(t) {
        t = Math.max(0, Math.min(1, t));
        return t * t * (3 - 2 * t);
    }

    /**
     * @param {number} dt      seconds
     * @param {object} ctx     { cars, order, simTime (ms), wide }
     */
    function update(dt, ctx) {
        const tSec = (ctx.simTime || 0) / 1000;

        if (manualTimer > 0) manualTimer -= dt;

        if (!enabled || ctx.wide) {
            activeShot = null;
            subjects = [];
            blend += (0 - blend) * Math.min(1, dt * 2.2);
        } else if (manualTimer <= 0) {
            _advancePlan(tSec, ctx);
        }

        _applyTargets(dt, ctx);

        if (shakeAmp > 0.05) {
            shakeT += dt;
            shakeAmp *= (1 - Math.min(1, dt * 4.5));
        } else shakeAmp = 0;
    }

    function _advancePlan(tSec, ctx) {
        // Retire a finished shot.
        if (activeShot && tSec > activeShot.done) {
            activeShot = null;
            subjects = [];
            shotLabel = '';
        }

        // Pick up the next scheduled shot when its lead-in begins.
        while (planIdx < plan.length && plan[planIdx].done < tSec) planIdx++;
        if (!activeShot && planIdx < plan.length && tSec >= plan[planIdx].start) {
            const s = plan[planIdx];
            const cars = s.carIds
                .map(id => ctx.cars.find(c => c.id === id))
                .filter(c => c && !c.retired);
            planIdx++;
            if (cars.length) {
                activeShot = s;
                subjects = cars;
                shotLabel = s.label;
            }
        }

        // Blend towards the subject during lead-in, away during lead-out.
        let want = 0;
        if (activeShot) {
            if (tSec < activeShot.peak) want = smoothstep((tSec - activeShot.start) / LEAD_IN);
            else if (tSec < activeShot.end) want = 1;
            else want = 1 - smoothstep((tSec - activeShot.end) / LEAD_OUT);
        }
        blend = want;
    }

    /** Compute the wide framing and the close framing, then interpolate. */
    function _applyTargets(dt, ctx) {
        // ── Wide: the whole circuit, unless the field is bunched into a
        //    corner of it, in which case close in a little so it reads.
        let wideX = worldW / 2, wideY = worldH / 2, wideZoom = minZoom;
        const running = (ctx.cars || []).filter(c => !c.retired);
        // An explicit wide request (results screens, camera off) means the
        // whole circuit, never the bunched-field push-in below.
        if (running.length && !ctx.wide) {
            const b = _bounds(running, 260);
            const z = Math.min(viewW / b.w, viewH / b.h);
            if (z > minZoom * 1.5) {
                // Everyone is together (start, safety car, first lap) — worth a push in.
                wideX = b.cx; wideY = b.cy;
                wideZoom = Math.min(minZoom * 1.65, z);
            }
        }

        // ── Close: frame the subjects of the current shot.
        let closeX = wideX, closeY = wideY, closeZoom = wideZoom;
        if (subjects.length) {
            const b = _bounds(subjects, PAD);
            closeX = b.cx; closeY = b.cy;
            closeZoom = Math.max(minZoom, Math.min(ZOOM_MAX, Math.min(viewW / b.w, viewH / b.h)));
        }

        const f = smoothstep(blend);
        const tx = wideX + (closeX - wideX) * f;
        const ty = wideY + (closeY - wideY) * f;
        const tz = wideZoom + (closeZoom - wideZoom) * f;

        // Follow tightly while locked on, drift gently when wide.
        const follow = 1.4 + f * 5.0;
        const k = Math.min(1, dt * follow);
        cam.x += (tx - cam.x) * k;
        cam.y += (ty - cam.y) * k;
        cam.zoom += (tz - cam.zoom) * Math.min(1, dt * (1.6 + f * 3.0));

        _clamp();
    }

    function _bounds(cars, pad) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const c of cars) {
            if (c.x < minX) minX = c.x;
            if (c.y < minY) minY = c.y;
            if (c.x > maxX) maxX = c.x;
            if (c.y > maxY) maxY = c.y;
        }
        return {
            cx: (minX + maxX) / 2, cy: (minY + maxY) / 2,
            w: (maxX - minX) + pad * 2, h: (maxY - minY) + pad * 2,
        };
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
    // Manual overrides
    // -------------------------------------------------------------------------

    /** Force a close-up outside the plan (used for the podium moment). */
    function spotlight(cars, seconds = 4.5, label = '') {
        if (!enabled) return;
        const list = (Array.isArray(cars) ? cars : [cars]).filter(c => c && !c.retired);
        if (!list.length) return;
        subjects = list;
        activeShot = null;
        shotLabel = label;
        manualTimer = seconds;
        blend = 1;
    }

    function goWide() {
        activeShot = null;
        subjects = [];
        manualTimer = 0;
        blend = 0;
    }

    function shake(amount) { shakeAmp = Math.min(22, shakeAmp + amount); shakeT = 0; }

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

    function getZoom()     { return cam.zoom; }
    function getMinZoom()  { return minZoom; }
    function getSubjects() { return blend > 0.25 ? subjects : []; }
    function getLabel()    { return blend > 0.35 ? shotLabel : ''; }
    function getBlend()    { return blend; }

    return {
        init, resize, update, apply, screenToWorld, worldToScreen,
        buildPlan, getPlan, rewind,
        spotlight, shake, goWide, setEnabled, isEnabled,
        getZoom, getMinZoom, getSubjects, getLabel, getBlend,
    };
})();
