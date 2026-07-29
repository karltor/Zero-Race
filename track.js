/**
 * Procedural track generation and rendering.
 *
 * Generation is fully deterministic: pass a seeded Rng stream and the same
 * seed always produces the same circuit.
 *
 * After the spline is built the track is *analysed*:
 *   - the longest straight becomes the start/finish straight (points are
 *     rotated so index 0 sits on it), which is also where the pit lane lives
 *   - other long straights become DRS zones with a detection point before them
 *   - the lap is split into three timing sectors
 */
const Track = (() => {
    let points = [];
    let trackWidth = 132;
    let finishIndex = 0;
    let totalLength = 0;
    let _rawCtrl   = [];   // original control points before Chaikin (editable by editor)
    let _debugCtrl = [];   // Chaikin-smoothed control polygon (for reference overlay)

    let _straights = [];   // [{start,end,lenPts,lenPx,fracStart,fracEnd,frac}]
    let _drsZones  = [];   // [{detect,start,end}] in progress fractions
    let _sectors   = [];   // [0, s1, s2] progress fractions
    let _pit       = null; // {entry,exit,side,offset,boxes:[progress...],speedLimit}
    let _name      = 'Circuit';

    const PIT_LANE_GAP = 8;    // px between track edge and pit lane
    const PIT_LANE_W   = 34;   // px width of the pit lane
    const PIT_SPEED    = 105;  // px/s speed limit in the pit lane

    const CIRCUIT_PREFIX = ['Nord', 'Val', 'Mont', 'Silver', 'Red', 'Sun', 'Storm', 'Iron', 'Cobalt', 'Zero',
                            'Black', 'Gold', 'Ash', 'Vent', 'Nova', 'Kant', 'Bris', 'Solar', 'Hollow', 'Vector'];
    const CIRCUIT_SUFFIX = ['ring', 'creek', 'gate', 'stone', 'hollow', 'park', 'reach', 'bend', 'spur', 'vale',
                            'point', 'ridge', 'field', 'shore', 'crest', 'basin'];

    // -------------------------------------------------------------------------
    // Generation
    // -------------------------------------------------------------------------

    /**
     * @param {number} w canvas / world width
     * @param {number} h canvas / world height
     * @param {object} rng seeded stream from Rng.create()
     */
    function generate(w, h, rng) {
        const R = rng || Rng.create(Rng.randomSeed());
        const cx = w / 2;
        const cy = h / 2;
        const margin = 42;
        const rx = (w - margin * 2) / 2;
        const ry = (h - margin * 2) / 2;

        let validAttempt = -1;
        let rejCtrl = 0, rejEdge = 0;
        for (let attempt = 0; attempt < 40; attempt++) {
            // Lots of control points is what makes a circuit feel like a
            // circuit rather than an oval: each one is a potential corner.
            const numCtrl = 16 + Math.floor(R.next() * 5);   // 16-20
            const ctrl = [];
            // Wide radius variation gives the mix of hairpins, sweepers and
            // straights. Keep it wide on every attempt — when a layout fails
            // we push the control points further apart instead of rounding
            // the shape off, which is what flattened tracks into ovals.
            // ── Layout ───────────────────────────────────────────────────
            // Independent random radii give a scribble; a *smooth* random walk
            // gives flowing sequences of corners, which is what a circuit is.
            // Straight sectors are then carved out explicitly.
            // Late attempts tame the radius variation towards a rounder shape.
            // Early attempts keep the full range, so a normal circuit is as
            // twisty as the settings allow and only the awkward seeds — the
            // ones that keep self-crossing — get smoothed out.
            const tame = Math.max(0, Math.min(0.97, (attempt - 14) / 18));

            const radii = [];
            let r = 0.45 + R.next() * 0.35;
            for (let i = 0; i < numCtrl; i++) {
                r += R.gauss() * 0.17 * (1 - tame);
                r = Math.max(0.30, Math.min(0.92, r));
                radii.push(r);
            }
            // Close the loop by removing the walk's net drift, spread evenly
            // around the lap. Blending towards the first radius instead would
            // flatten the middle of the circuit back into an oval.
            const drift = radii[numCtrl - 1] - radii[0];
            for (let i = 0; i < numCtrl; i++) {
                radii[i] = Math.max(0.30, Math.min(0.93, radii[i] - drift * (i / (numCtrl - 1))));
            }

            for (let i = 0; i < numCtrl; i++) {
                const angle = (i / numCtrl) * Math.PI * 2;
                ctrl.push({
                    x: cx + Math.cos(angle) * rx * radii[i],
                    y: cy + Math.sin(angle) * ry * radii[i]
                });
            }

            // Carve two or three straights: pull the interior points of a
            // sector onto the line between its ends. Somewhere to run DRS and
            // actually complete an overtake.
            const straightCount = tame > 0.55 ? 0 : 2 + (R.next() < 0.4 ? 1 : 0);
            // Straights must not eat the circuit: cap them at ~40% of the
            // control points or everything in between stops being a corner.
            const maxClaimed = Math.round(numCtrl * 0.40);
            const claimed = new Set();
            let made = 0;
            for (let attemptS = 0; attemptS < 20 && made < straightCount; attemptS++) {
                const span = 3;
                const start = Math.floor(R.next() * numCtrl);
                if (claimed.size + span + 1 > maxClaimed) break;

                let free = true;
                // Leave a gap either side so two straights never merge into one.
                for (let j = -1; j <= span + 1; j++) {
                    if (claimed.has(((start + j) % numCtrl + numCtrl) % numCtrl)) free = false;
                }
                if (!free) continue;

                const a = ctrl[start], b = ctrl[(start + span) % numCtrl];
                for (let j = 1; j < span; j++) {
                    const f = j / span;
                    ctrl[(start + j) % numCtrl] = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
                }
                for (let j = 0; j <= span; j++) claimed.add((start + j) % numCtrl);
                made++;
            }

            // Pull a couple of unclaimed points hard towards the centre. These
            // become the slow corners — the hairpins and tight complexes that
            // make a circuit memorable instead of one long sweeping loop.
            if (tame < 0.4) {
                const tight = 1 + Math.floor(R.next() * 2);
                for (let k = 0, tries = 0; k < tight && tries < 18; tries++) {
                    const i = Math.floor(R.next() * numCtrl);
                    if (claimed.has(i)) continue;
                    // Never next to a straight: a hairpin right at the end of
                    // one leaves no braking zone and the AI just runs wide.
                    if (claimed.has((i + 1) % numCtrl) || claimed.has((i - 1 + numCtrl) % numCtrl)) continue;
                    const pull = 0.52 + R.next() * 0.22;
                    ctrl[i] = { x: cx + (ctrl[i].x - cx) * pull, y: cy + (ctrl[i].y - cy) * pull };
                    claimed.add(i);
                    k++;
                }
            }

            // Adjacent control points closer than this pinch the inner edge
            // shut once the spline is offset by half the track width.
            // Capped: an ever-growing spacing requirement makes the push-apart
            // loop below inflate the whole layout instead of nudging one pair,
            // which distorts the shape and creates the very crossings it was
            // meant to avoid.
            const minSpacing = trackWidth * Math.min(1.70, 1.20 + attempt * 0.02);

            for (let iter = 0; iter < 8; iter++) {
                for (let i = 0; i < ctrl.length; i++) {
                    const next = ctrl[(i + 1) % ctrl.length];
                    const dx = next.x - ctrl[i].x, dy = next.y - ctrl[i].y;
                    const d = Math.sqrt(dx * dx + dy * dy);
                    if (d < minSpacing) {
                        const mx = (ctrl[i].x + next.x) / 2;
                        const my = (ctrl[i].y + next.y) / 2;
                        ctrl[i].x += (ctrl[i].x - mx) * 0.4;
                        ctrl[i].y += (ctrl[i].y - my) * 0.4;
                        next.x += (next.x - mx) * 0.4;
                        next.y += (next.y - my) * 0.4;
                    }
                }
            }

            // Reject early if the raw control polygon self-intersects — Chaikin
            // preserves crossings, so a crossing polygon means a crossing spline.
            if (_findCtrlCross(ctrl)) { rejCtrl++; continue; }

            _rawCtrl = ctrl.map(p => ({ ...p }));

            _chaikin(ctrl, 2);
            _debugCtrl = ctrl.map(p => ({ ...p }));

            points = catmullRomChain(ctrl, 15);
            computeLength();
            _buildCurvature();

            if (!_findEdgeCross()) { validAttempt = attempt; break; }
            rejEdge++;
        }

        if (validAttempt < 0) {
            console.warn(`[track] no clean layout in 40 attempts (${rejCtrl} self-crossing polygons, ${rejEdge} pinched edges) — using last`);
        }

        _analyse(R);
        _name = R.pick(CIRCUIT_PREFIX) + R.pick(CIRCUIT_SUFFIX) +
                (R.chance(0.35) ? ' International' : R.chance(0.5) ? ' Circuit' : ' Raceway');
        return points;
    }

    function _chaikin(ctrl, passes) {
        for (let pass = 0; pass < passes; pass++) {
            const smooth = [];
            const nc = ctrl.length;
            for (let i = 0; i < nc; i++) {
                const a = ctrl[i], b = ctrl[(i + 1) % nc];
                smooth.push({ x: a.x + 0.25 * (b.x - a.x), y: a.y + 0.25 * (b.y - a.y) });
                smooth.push({ x: a.x + 0.75 * (b.x - a.x), y: a.y + 0.75 * (b.y - a.y) });
            }
            ctrl.length = 0;
            smooth.forEach(p => ctrl.push(p));
        }
    }

    // -------------------------------------------------------------------------
    // Analysis: straights → start/finish, pit lane, DRS zones, sectors
    // -------------------------------------------------------------------------

    /** Curvature smoothed over a wide window — used for layout analysis, not driving. */
    function _wideCurvature(idx) {
        const n = points.length;
        const look = 14;
        const p0 = points[(idx - look + n) % n], p1 = points[idx], p2 = points[(idx + look) % n];
        const dx1 = p1.x - p0.x, dy1 = p1.y - p0.y;
        const dx2 = p2.x - p1.x, dy2 = p2.y - p1.y;
        const cross = Math.abs(dx1 * dy2 - dy1 * dx2);
        const dot = Math.sqrt(dx1 * dx1 + dy1 * dy1) * Math.sqrt(dx2 * dx2 + dy2 * dy2);
        return dot > 0 ? cross / dot : 0;
    }

    function _findStraights(threshold) {
        const n = points.length;
        const flat = [];
        for (let i = 0; i < n; i++) flat.push(_wideCurvature(i) < threshold);

        // Find maximal circular runs of `true`
        let start = 0;
        while (start < n && flat[start]) start++;
        if (start === n) return [{ start: 0, end: n - 1, lenPts: n }];   // perfect circle, unlikely

        const runs = [];
        let i = 0, cur = null;
        while (i < n) {
            const idx = (start + i) % n;
            if (flat[idx]) {
                if (!cur) cur = { start: idx, lenPts: 0 };
                cur.lenPts++;
            } else if (cur) {
                cur.end = (cur.start + cur.lenPts - 1) % n;
                runs.push(cur);
                cur = null;
            }
            i++;
        }
        if (cur) { cur.end = (cur.start + cur.lenPts - 1) % n; runs.push(cur); }
        return runs;
    }

    /** Relax the "is this straight?" threshold until we have a few candidates. */
    function _pickStraights(n) {
        let bestRuns = [];
        for (const th of [0.010, 0.016, 0.024, 0.034, 0.048, 0.065]) {
            const runs = _findStraights(th).filter(r => r.lenPts > n * 0.035);
            if (runs.length > bestRuns.length) bestRuns = runs;
            if (bestRuns.length >= 3) break;
        }
        return bestRuns;
    }

    /** True when a pit lane on `side` would run into another part of the circuit. */
    function _pitSideClear(window, side) {
        const n = points.length;
        const off = side * (trackWidth / 2 + PIT_LANE_GAP + PIT_LANE_W);
        const iStart = ((Math.round(window.fracStart * n) % n) + n) % n;
        const span = window.lenPts;
        const minClear = trackWidth / 2 + 14;

        for (let k = 0; k <= span; k += 3) {
            const i = (iStart + k) % n;
            const nm = normalAt(i);
            const px = points[i].x + nm.x * off;
            const py = points[i].y + nm.y * off;
            for (let j = 0; j < n; j += 3) {
                // Ignore the stretch of centre line the pit lane runs alongside.
                const rel = ((j - iStart) % n + n) % n;
                if (rel <= span + 25 || rel >= n - 25) continue;
                const dx = points[j].x - px, dy = points[j].y - py;
                if (dx * dx + dy * dy < minClear * minClear) return false;
            }
        }
        return true;
    }

    function _analyse(R) {
        const n = points.length;
        if (n < 10) return;

        // 1. Locate straights, relax the threshold until we find a usable one.
        let runs = _pickStraights(n);
        if (!runs.length) runs = [{ start: 0, end: Math.floor(n * 0.1), lenPts: Math.floor(n * 0.1) }];
        runs.sort((a, b) => b.lenPts - a.lenPts);

        // 2. Rotate the point array so index 0 sits 55% along the longest straight.
        //    The start/finish line, the grid and the pit lane all live there.
        const main = runs[0];
        const shift = (main.start + Math.round(main.lenPts * 0.55)) % n;
        points = points.slice(shift).concat(points.slice(0, shift));
        computeLength();
        _buildCurvature();
        finishIndex = 0;

        // 3. Re-find straights in the new indexing.
        let straights = _pickStraights(n);
        if (!straights.length) {
            // Fall back to a synthetic straight centred on the (rotated) index 0.
            const m = Math.max(6, Math.round(n * 0.08));
            straights = [{ start: (n - Math.round(m * 0.55)) % n, end: Math.round(m * 0.45) % n, lenPts: m }];
        }
        _straights = straights.map(s => {
            const fracStart = s.start / n;
            const fracEnd   = ((s.start + s.lenPts) % n) / n;
            return {
                start: s.start, end: s.end, lenPts: s.lenPts,
                lenPx: s.lenPts / n * totalLength,
                fracStart, fracEnd, frac: s.lenPts / n,
            };
        }).sort((a, b) => b.lenPts - a.lenPts);

        // 4. Pit lane, centred on the start/finish line. Short circuits still
        //    need a lane long enough to hold eight boxes and to look right, so
        //    it is stretched beyond the straight when necessary.
        const pitStraight = _straights.find(s => inRange(0, s.fracStart, s.fracEnd)) || _straights[0];
        const pitHalf = Math.max(0.075, Math.min(0.14, pitStraight.frac * 0.6));
        const pitWindow = {
            fracStart: wrap(-pitHalf),
            frac: pitHalf * 2,
            lenPts: Math.round(pitHalf * 2 * n),
        };

        const preferred = _outerSide(0);
        const pitSide = _pitSideClear(pitWindow, preferred) ? preferred
                      : (_pitSideClear(pitWindow, -preferred) ? -preferred : preferred);

        // Eight boxes spread across the middle 62% of the lane.
        const boxes = [];
        const boxSpan = pitWindow.frac * 0.62;
        const boxStart = wrap(pitWindow.fracStart + pitWindow.frac * 0.20);
        for (let i = 0; i < 8; i++) boxes.push(wrap(boxStart + boxSpan * (i / 7)));

        _pit = {
            entry: pitWindow.fracStart,
            exit:  wrap(pitWindow.fracStart + pitWindow.frac),
            side:  pitSide,
            offset: pitSide * (trackWidth / 2 + PIT_LANE_GAP + PIT_LANE_W / 2),
            boxes,
            speedLimit: PIT_SPEED,
        };

        // 5. DRS zones on the other long straights (never on the pit straight —
        //    a DRS train down the pit lane would look silly).
        _drsZones = [];
        for (const s of _straights) {
            if (s === pitStraight) continue;
            if (s.frac < 0.040) continue;
            _drsZones.push({
                detect: wrap(s.fracStart - 0.055),
                start:  wrap(s.fracStart + s.frac * 0.18),
                end:    wrap(s.fracStart + s.frac * 0.96),
            });
            if (_drsZones.length >= 3) break;
        }
        // Every circuit deserves at least one DRS zone — fall back to the main straight.
        if (!_drsZones.length) {
            _drsZones.push({
                detect: wrap(pitStraight.fracStart - 0.05),
                start:  wrap(pitStraight.fracStart + pitStraight.frac * 0.20),
                end:    wrap(pitStraight.fracStart + pitStraight.frac * 0.92),
            });
        }

        // 6. Three roughly equal sectors, nudged onto the nearest corner exit.
        _sectors = [0, 1 / 3, 2 / 3];
    }

    /** Which normal direction points away from the track's centroid at `idx`. */
    function _outerSide(idx) {
        let sx = 0, sy = 0;
        for (const p of points) { sx += p.x; sy += p.y; }
        const cx = sx / points.length, cy = sy / points.length;
        const nrm = normalAt(idx);
        const p = points[idx];
        return ((p.x - cx) * nrm.x + (p.y - cy) * nrm.y) >= 0 ? 1 : -1;
    }

    // -------------------------------------------------------------------------
    // Progress helpers (progress = fraction around the lap, 0..1)
    // -------------------------------------------------------------------------

    function wrap(p) { return ((p % 1) + 1) % 1; }

    /** True if progress p lies in [a,b] going forward, handling the 0/1 wrap. */
    function inRange(p, a, b) {
        p = wrap(p); a = wrap(a); b = wrap(b);
        return a <= b ? (p >= a && p <= b) : (p >= a || p <= b);
    }

    /** Shortest forward distance from a to b in progress units. */
    function forwardDist(a, b) { return wrap(b - a); }

    /** Signed shortest difference a→b in [-0.5, 0.5]. */
    function signedDist(a, b) {
        let d = wrap(b - a);
        if (d > 0.5) d -= 1;
        return d;
    }

    function isInDrs(progress) {
        for (const z of _drsZones) if (inRange(progress, z.start, z.end)) return z;
        return null;
    }

    function drsDetectionCrossed(prev, now) {
        for (const z of _drsZones) {
            if (forwardDist(prev, z.detect) <= forwardDist(prev, now) && prev !== now) return z;
        }
        return null;
    }

    // -------------------------------------------------------------------------
    // Editor API
    // -------------------------------------------------------------------------

    function getCtrlPoints() { return _rawCtrl; }

    function setCtrlPoint(i, x, y) {
        if (_rawCtrl[i]) { _rawCtrl[i].x = x; _rawCtrl[i].y = y; }
    }

    function rebuildFromCtrl() {
        const ctrl = _rawCtrl.map(p => ({ ...p }));
        _chaikin(ctrl, 2);
        _debugCtrl = ctrl.map(p => ({ ...p }));
        points = catmullRomChain(ctrl, 15);
        computeLength();
        _buildCurvature();
        _analyse(Rng.create(1));
    }

    function drawDebug(ctx, editMode = false) {
        if (!_rawCtrl.length) return;
        const n = _rawCtrl.length;

        ctx.save();
        ctx.setLineDash([8, 6]);
        ctx.strokeStyle = 'rgba(255,255,0,0.55)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(_rawCtrl[0].x, _rawCtrl[0].y);
        for (let i = 1; i < n; i++) ctx.lineTo(_rawCtrl[i].x, _rawCtrl[i].y);
        ctx.closePath();
        ctx.stroke();

        const r = editMode ? 14 : 9;
        for (let i = 0; i < n; i++) {
            const p = _rawCtrl[i];
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
            ctx.fillStyle = editMode ? 'rgba(255,200,0,0.92)' : 'rgba(255,80,80,0.88)';
            ctx.fill();
            ctx.strokeStyle = editMode ? '#fff' : 'rgba(255,255,255,0.7)';
            ctx.lineWidth = editMode ? 2 : 1.5;
            ctx.stroke();
            ctx.fillStyle = editMode ? '#000' : '#fff';
            ctx.font = `bold ${editMode ? 12 : 10}px monospace`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(i, p.x, p.y);
        }
        ctx.restore();
    }

    // -------------------------------------------------------------------------
    // Geometry validation
    // -------------------------------------------------------------------------

    function _findCtrlCross(ctrl) {
        const n = ctrl.length;
        for (let i = 0; i < n; i++) {
            const a = ctrl[i], b = ctrl[(i + 1) % n];
            for (let k = 2; k < n - 1; k++) {
                const j = (i + k) % n;
                const c = ctrl[j], d = ctrl[(j + 1) % n];
                if (_segIntersect(a, b, c, d)) return { i, j };
            }
        }
        return null;
    }

    function _findEdgeCross() {
        const n   = points.length;
        const hw  = trackWidth / 2;
        const maxK = Math.floor(n / 2);

        for (const sign of [1, -1]) {
            const edge = [];
            for (let i = 0; i < n; i++) {
                const norm = normalAt(i);
                edge.push({
                    x: points[i].x + norm.x * hw * sign,
                    y: points[i].y + norm.y * hw * sign
                });
            }
            for (let i = 0; i < n; i++) {
                const a = edge[i], b = edge[(i + 1) % n];
                for (let k = 2; k <= maxK; k++) {
                    const j = (i + k) % n;
                    const c = edge[j], d = edge[(j + 1) % n];
                    if (_segIntersect(a, b, c, d)) return { sign, i, j };
                }
            }
        }
        return null;
    }

    function _segIntersect(p1, p2, p3, p4) {
        const d1x = p2.x - p1.x, d1y = p2.y - p1.y;
        const d2x = p4.x - p3.x, d2y = p4.y - p3.y;
        const denom = d1x * d2y - d1y * d2x;
        if (Math.abs(denom) < 1e-8) return false;
        const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
        const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denom;
        return t > 0.01 && t < 0.99 && u > 0.01 && u < 0.99;
    }

    // -------------------------------------------------------------------------
    // Spline
    // -------------------------------------------------------------------------

    function catmullRomChain(ctrl, segPts) {
        const result = [];
        const n = ctrl.length;
        for (let i = 0; i < n; i++) {
            const p0 = ctrl[(i - 1 + n) % n], p1 = ctrl[i];
            const p2 = ctrl[(i + 1) % n],     p3 = ctrl[(i + 2) % n];
            for (let s = 0; s < segPts; s++) {
                result.push(centripetalCR(p0, p1, p2, p3, s / segPts));
            }
        }
        return result;
    }

    /**
     * Centripetal Catmull-Rom (α = 0.5): parameterised by √(chord length),
     * which removes the cusps uniform CR produces when control point spacing
     * varies a lot.  Barry & Goldman (1988).
     */
    function centripetalCR(p0, p1, p2, p3, t) {
        function knot(a, b) {
            const dx = b.x - a.x, dy = b.y - a.y;
            return Math.pow(dx * dx + dy * dy, 0.25);
        }

        const t0 = 0;
        const t1 = t0 + knot(p0, p1);
        const t2 = t1 + knot(p1, p2);
        const t3 = t2 + knot(p2, p3);

        if (Math.abs(t2 - t1) < 1e-8) return { x: p1.x, y: p1.y };

        const tp = t1 + (t2 - t1) * t;

        function lp(a, b, ta, tb, tc) {
            const d = tb - ta;
            if (Math.abs(d) < 1e-8) return { x: a.x, y: a.y };
            const f = (tc - ta) / d;
            return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
        }

        const A1 = lp(p0, p1, t0, t1, tp);
        const A2 = lp(p1, p2, t1, t2, tp);
        const A3 = lp(p2, p3, t2, t3, tp);
        const B1 = lp(A1, A2, t0, t2, tp);
        const B2 = lp(A2, A3, t1, t3, tp);
        return lp(B1, B2, t1, t2, tp);
    }

    function computeLength() {
        totalLength = 0;
        const n = points.length;
        for (let i = 0; i < n; i++) {
            const next = points[(i + 1) % n];
            const dx = next.x - points[i].x, dy = next.y - points[i].y;
            totalLength += Math.sqrt(dx * dx + dy * dy);
        }
    }

    function normalAt(idx) {
        const n = points.length;
        const next = points[(idx + 1) % n], prev = points[(idx - 1 + n) % n];
        const dx = next.x - prev.x, dy = next.y - prev.y;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        return { x: -dy / len, y: dx / len };
    }

    function angleAt(idx) {
        const n = points.length;
        const next = points[(idx + 1) % n], prev = points[(idx - 1 + n) % n];
        return Math.atan2(next.y - prev.y, next.x - prev.x);
    }

    let _curvCache = null;

    function _buildCurvature() {
        const n = points.length;
        _curvCache = new Float32Array(n);
        for (let i = 0; i < n; i++) _curvCache[i] = _curvatureRaw(i);
    }

    function curvatureAt(idx) {
        if (_curvCache) return _curvCache[idx % _curvCache.length];
        return _curvatureRaw(idx);
    }

    function _curvatureRaw(idx) {
        const n = points.length;
        const look = 5;
        const p0 = points[(idx - look + n) % n], p1 = points[idx], p2 = points[(idx + look) % n];
        const dx1 = p1.x - p0.x, dy1 = p1.y - p0.y;
        const dx2 = p2.x - p1.x, dy2 = p2.y - p1.y;
        const cross = Math.abs(dx1 * dy2 - dy1 * dx2);
        const dot = Math.sqrt(dx1 * dx1 + dy1 * dy1) * Math.sqrt(dx2 * dx2 + dy2 * dy2);
        return dot > 0 ? cross / dot : 0;
    }

    // -------------------------------------------------------------------------
    // Rendering
    // -------------------------------------------------------------------------

    function draw(ctx) {
        const n = points.length;
        if (n < 2) return;

        drawPitLane(ctx);

        // Track shadow
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.5)';
        ctx.shadowBlur = 25;
        drawTrackPath(ctx, trackWidth + 12);
        ctx.fillStyle = '#2a2a2a';
        ctx.fill();
        ctx.restore();

        drawTrackPath(ctx, trackWidth);
        ctx.fillStyle = '#4a4a4a';
        ctx.fill();

        drawTrackPath(ctx, trackWidth * 0.7);
        ctx.fillStyle = '#525252';
        ctx.fill();

        drawDrsZones(ctx);

        // Racing line hint
        ctx.save();
        ctx.setLineDash([20, 30]);
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < n; i++) ctx.lineTo(points[i].x, points[i].y);
        ctx.closePath();
        ctx.stroke();
        ctx.restore();

        drawEdgeLine(ctx,  trackWidth / 2, 'rgba(255,255,255,0.5)', 2);
        drawEdgeLine(ctx, -trackWidth / 2, 'rgba(255,255,255,0.5)', 2);

        drawCurbs(ctx);
        drawSectorMarkers(ctx);
        drawStartGrid(ctx);
        drawFinishLine(ctx);
    }

    function drawTrackPath(ctx, width) {
        const n = points.length;
        const outer = [], inner = [];
        for (let i = 0; i < n; i++) {
            const norm = normalAt(i);
            outer.push({ x: points[i].x + norm.x * width / 2, y: points[i].y + norm.y * width / 2 });
            inner.push({ x: points[i].x - norm.x * width / 2, y: points[i].y - norm.y * width / 2 });
        }
        ctx.beginPath();
        ctx.moveTo(outer[0].x, outer[0].y);
        for (let i = 1; i < n; i++) ctx.lineTo(outer[i].x, outer[i].y);
        ctx.closePath();
        for (let i = n - 1; i >= 0; i--) {
            if (i === n - 1) ctx.moveTo(inner[i].x, inner[i].y);
            else ctx.lineTo(inner[i].x, inner[i].y);
        }
        ctx.closePath();
    }

    function drawEdgeLine(ctx, offset, color, width) {
        const n = points.length;
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
            const norm = normalAt(i);
            ctx.lineTo(points[i].x + norm.x * offset, points[i].y + norm.y * offset);
        }
        ctx.closePath();
        ctx.stroke();
        ctx.restore();
    }

    function drawCurbs(ctx) {
        const n = points.length;
        ctx.save();
        for (let i = 0; i < n; i += 3) {
            const curv = curvatureAt(i);
            if (curv <= 0.06) continue;
            const norm = normalAt(i);
            const intensity = Math.min(1, curv * 5);

            const look = 5;
            const p0 = points[(i - look + n) % n];
            const p2 = points[(i + look) % n];
            const cross = (points[i].x - p0.x) * (p2.y - points[i].y) -
                          (points[i].y - p0.y) * (p2.x - points[i].x);
            const outerSide = cross >= 0 ? 1 : -1;

            for (const side of [1, -1]) {
                if (curv > 0.09 && side !== outerSide) continue;
                const off = (trackWidth / 2 + 1) * side;
                const px = points[i].x + norm.x * off;
                const py = points[i].y + norm.y * off;
                ctx.fillStyle = Math.floor(i / 3) % 2 === 0
                    ? `rgba(204,34,34,${intensity * 0.8})`
                    : `rgba(255,255,255,${intensity * 0.8})`;
                ctx.fillRect(px - 4, py - 4, 8, 8);
            }
        }
        ctx.restore();
    }

    /** Faint blue tint + boundary lines marking every DRS zone. */
    function drawDrsZones(ctx) {
        const n = points.length;
        ctx.save();
        for (const z of _drsZones) {
            const iStart = Math.round(z.start * n);
            const span = Math.round(forwardDist(z.start, z.end) * n);

            ctx.globalAlpha = 0.10;
            ctx.fillStyle = '#39d0ff';
            ctx.beginPath();
            for (let k = 0; k <= span; k++) {
                const i = (iStart + k) % n;
                const nm = normalAt(i);
                ctx.lineTo(points[i].x + nm.x * trackWidth * 0.48, points[i].y + nm.y * trackWidth * 0.48);
            }
            for (let k = span; k >= 0; k--) {
                const i = (iStart + k) % n;
                const nm = normalAt(i);
                ctx.lineTo(points[i].x - nm.x * trackWidth * 0.48, points[i].y - nm.y * trackWidth * 0.48);
            }
            ctx.closePath();
            ctx.fill();

            // Zone start line + label
            ctx.globalAlpha = 0.75;
            _crossLine(ctx, iStart, trackWidth * 0.48, 'rgba(60,210,255,0.8)', 2, [7, 5]);
            const nm = normalAt(iStart);
            const lx = points[iStart].x + nm.x * (trackWidth * 0.5 + 16);
            const ly = points[iStart].y + nm.y * (trackWidth * 0.5 + 16);
            ctx.setLineDash([]);
            ctx.fillStyle = 'rgba(60,210,255,0.85)';
            ctx.font = 'bold 13px Arial';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('DRS', lx, ly);

            // Detection point
            ctx.globalAlpha = 0.5;
            _crossLine(ctx, Math.round(z.detect * n), trackWidth * 0.48, 'rgba(60,210,255,0.5)', 1.5, [3, 6]);
        }
        ctx.restore();
    }

    function _crossLine(ctx, idx, halfWidth, color, lw, dash) {
        const nm = normalAt(idx);
        const p = points[idx];
        ctx.save();
        ctx.setLineDash(dash || []);
        ctx.strokeStyle = color;
        ctx.lineWidth = lw;
        ctx.beginPath();
        ctx.moveTo(p.x + nm.x * halfWidth, p.y + nm.y * halfWidth);
        ctx.lineTo(p.x - nm.x * halfWidth, p.y - nm.y * halfWidth);
        ctx.stroke();
        ctx.restore();
    }

    function drawSectorMarkers(ctx) {
        const n = points.length;
        for (let s = 1; s < _sectors.length; s++) {
            const idx = Math.round(_sectors[s] * n) % n;
            _crossLine(ctx, idx, trackWidth * 0.5, 'rgba(255,255,255,0.28)', 2, [6, 8]);
        }
    }

    function drawPitLane(ctx) {
        if (!_pit) return;
        const n = points.length;
        const iStart = Math.round(_pit.entry * n);
        const span = Math.max(2, Math.round(forwardDist(_pit.entry, _pit.exit) * n));
        const inner = _pit.side * (trackWidth / 2 + PIT_LANE_GAP);
        const outer = _pit.side * (trackWidth / 2 + PIT_LANE_GAP + PIT_LANE_W);

        ctx.save();

        // Tarmac
        ctx.beginPath();
        for (let k = 0; k <= span; k++) {
            const i = (iStart + k) % n;
            const nm = normalAt(i);
            ctx.lineTo(points[i].x + nm.x * inner, points[i].y + nm.y * inner);
        }
        for (let k = span; k >= 0; k--) {
            const i = (iStart + k) % n;
            const nm = normalAt(i);
            ctx.lineTo(points[i].x + nm.x * outer, points[i].y + nm.y * outer);
        }
        ctx.closePath();
        ctx.fillStyle = '#3d3d42';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.45)';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Pit boxes, one per car, in team order
        const teamOrder = ['blue', 'blue', 'yellow', 'yellow', 'red', 'red', 'green', 'green'];
        for (let b = 0; b < _pit.boxes.length; b++) {
            const idx = Math.round(_pit.boxes[b] * n) % n;
            const nm = normalAt(idx);
            const p = points[idx];
            const ang = angleAt(idx);
            const bx = p.x + nm.x * _pit.offset;
            const by = p.y + nm.y * _pit.offset;
            ctx.save();
            ctx.translate(bx, by);
            ctx.rotate(ang);
            const col = (typeof CarSVG !== 'undefined' && CarSVG.TEAM_COLORS[teamOrder[b]])
                ? CarSVG.TEAM_COLORS[teamOrder[b]].main : '#888';
            ctx.globalAlpha = 0.55;
            ctx.fillStyle = col;
            ctx.fillRect(-16, -PIT_LANE_W / 2 + 3, 32, PIT_LANE_W - 6);
            ctx.globalAlpha = 0.9;
            ctx.strokeStyle = 'rgba(255,255,255,0.6)';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(-16, -PIT_LANE_W / 2 + 3, 32, PIT_LANE_W - 6);
            ctx.restore();
        }

        // Dashed separation line between circuit and pit lane
        ctx.save();
        ctx.setLineDash([10, 8]);
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let k = 0; k <= span; k++) {
            const i = (iStart + k) % n;
            const nm = normalAt(i);
            ctx.lineTo(points[i].x + nm.x * inner, points[i].y + nm.y * inner);
        }
        ctx.stroke();
        ctx.restore();

        // "PIT LANE" label near the entry
        const li = (iStart + Math.round(span * 0.06)) % n;
        const lnm = normalAt(li);
        const lang = angleAt(li);
        ctx.save();
        ctx.translate(points[li].x + lnm.x * _pit.offset, points[li].y + lnm.y * _pit.offset);
        // Keep the label upright whichever way the straight runs.
        ctx.rotate(Math.abs(lang) > Math.PI / 2 ? lang + Math.PI : lang);
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.font = 'bold 11px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('PIT LANE', 0, 0);
        ctx.restore();

        ctx.restore();
    }

    /** Painted starting boxes behind the line, matching the grid layout in Sim. */
    function drawStartGrid(ctx) {
        const n = points.length;
        ctx.save();
        for (let i = 0; i < 8; i++) {
            const prog = wrap(-0.008 - i * 0.017);
            const side = i % 2 === 0 ? -1 : 1;
            const idx = Math.round(prog * n) % n;
            const nm = normalAt(idx);
            const p = points[idx];
            const off = side * 20;
            ctx.save();
            ctx.translate(p.x + nm.x * off, p.y + nm.y * off);
            ctx.rotate(angleAt(idx));
            ctx.globalAlpha = 0.5;
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(-16, -14); ctx.lineTo(-22, -14); ctx.lineTo(-22, 14); ctx.lineTo(-16, 14);
            ctx.stroke();
            ctx.globalAlpha = 0.32;
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 11px Arial';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(String(i + 1), -33, 0);
            ctx.restore();
        }
        ctx.restore();
    }

    function drawFinishLine(ctx) {
        const norm = normalAt(finishIndex);
        const hw = trackWidth / 2;
        const p = points[finishIndex];
        const sx = p.x + norm.x * hw, sy = p.y + norm.y * hw;
        const ex = p.x - norm.x * hw, ey = p.y - norm.y * hw;

        ctx.save();
        const steps = 10;
        const angle = Math.atan2(ey - sy, ex - sx);
        const perpX = Math.cos(angle + Math.PI / 2);
        const perpY = Math.sin(angle + Math.PI / 2);
        for (let i = 0; i < steps; i++) {
            for (let row = 0; row < 2; row++) {
                const f = i / steps;
                const x1 = sx + (ex - sx) * f;
                const y1 = sy + (ey - sy) * f;
                ctx.fillStyle = (i + row) % 2 === 0 ? '#fff' : '#111';
                ctx.save();
                ctx.translate(x1 + perpX * row * 5, y1 + perpY * row * 5);
                ctx.rotate(angle);
                const segW = Math.sqrt((ex - sx) ** 2 + (ey - sy) ** 2) / steps;
                ctx.fillRect(0, -2.5, segW + 0.5, 5);
                ctx.restore();
            }
        }
        ctx.restore();
    }

    // -------------------------------------------------------------------------
    // Queries
    // -------------------------------------------------------------------------

    function getPositionAt(progress, laneOffset) {
        const n = points.length;
        const frac = wrap(progress);
        const exactIdx = frac * n;
        const idx = Math.floor(exactIdx);
        const t = exactIdx - idx;
        const p1 = points[idx % n], p2 = points[(idx + 1) % n];
        const x = p1.x + (p2.x - p1.x) * t;
        const y = p1.y + (p2.y - p1.y) * t;
        const norm = normalAt(idx);
        return {
            x: x + norm.x * laneOffset,
            y: y + norm.y * laneOffset,
            angle: angleAt(idx)
        };
    }

    function closestPoint(wx, wy) {
        const n = points.length;
        let bestDist = Infinity, bestIdx = 0;
        for (let i = 0; i < n; i += 5) {
            const dx = points[i].x - wx, dy = points[i].y - wy;
            const d = dx * dx + dy * dy;
            if (d < bestDist) { bestDist = d; bestIdx = i; }
        }
        const start = (bestIdx - 8 + n) % n;
        bestDist = Infinity;
        for (let j = 0; j < 16; j++) {
            const i = (start + j) % n;
            const dx = points[i].x - wx, dy = points[i].y - wy;
            const d = dx * dx + dy * dy;
            if (d < bestDist) { bestDist = d; bestIdx = i; }
        }
        return { index: bestIdx, progress: bestIdx / n, dist: Math.sqrt(bestDist) };
    }

    /** Bounding box of the drivable area, used to frame the camera. */
    function getBounds() {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const pad = trackWidth / 2 + PIT_LANE_GAP + PIT_LANE_W;
        for (const p of points) {
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
        }
        return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
    }

    /**
     * Nearest centre-line point, searching outward from a hint index first.
     * Falls back to the full scan when the car is nowhere near the hint
     * (teleport, respawn, first frame).
     */
    function closestPointNear(wx, wy, hintIdx) {
        const n = points.length;
        if (!n) return { index: 0, progress: 0, dist: 0 };
        if (hintIdx === undefined || hintIdx === null) return closestPoint(wx, wy);

        const WIN = 12;
        let bestDist = Infinity, bestIdx = 0, bestOffset = 0;
        for (let k = -WIN; k <= WIN; k++) {
            const i = ((hintIdx + k) % n + n) % n;
            const dx = points[i].x - wx, dy = points[i].y - wy;
            const d = dx * dx + dy * dy;
            if (d < bestDist) { bestDist = d; bestIdx = i; bestOffset = k; }
        }
        // Best match sitting on the window edge means the hint was stale.
        if (Math.abs(bestOffset) >= WIN - 1) return closestPoint(wx, wy);
        return { index: bestIdx, progress: bestIdx / n, dist: Math.sqrt(bestDist) };
    }

    function getTrackLength() { return totalLength; }
    function getPoints()      { return points; }
    function getWidth()       { return trackWidth; }
    function getPointCount()  { return points.length; }
    function getStraights()   { return _straights; }
    function getDrsZones()    { return _drsZones; }
    function getSectors()     { return _sectors; }
    function getPit()         { return _pit; }
    function getName()        { return _name; }
    function getPitLaneWidth(){ return PIT_LANE_W; }

    return {
        generate, draw, drawDebug, getPositionAt, getTrackLength,
        getPoints, getWidth, angleAt, normalAt, curvatureAt,
        closestPoint, closestPointNear, getPointCount, getBounds,
        getCtrlPoints, setCtrlPoint, rebuildFromCtrl,
        getStraights, getDrsZones, getSectors, getPit, getName, getPitLaneWidth,
        wrap, inRange, forwardDist, signedDist, isInDrs, drsDetectionCrossed,
    };
})();
