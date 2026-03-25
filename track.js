/**
 * Procedural track generation and rendering.
 * Uses catmull-rom splines for smooth curves. Track fills available space.
 */
const Track = (() => {
    let points = [];
    let trackWidth = 150;
    let finishIndex = 0;
    let totalLength = 0;
    let _debugCtrl = [];   // last control polygon for visual overlay

    function generate(w, h) {
        const cx = w / 2;
        const cy = h / 2;
        const margin = 35;
        const rx = (w - margin * 2) / 2;
        const ry = (h - margin * 2) / 2;

        console.log(`[track] canvas ${w}x${h}  rx=${rx.toFixed(0)} ry=${ry.toFixed(0)}`);

        let validAttempt = -1;
        for (let attempt = 0; attempt < 14; attempt++) {
            const numCtrl = 8 + Math.floor(Math.random() * 5);
            const ctrl = [];
            for (let i = 0; i < numCtrl; i++) {
                const angle = (i / numCtrl) * Math.PI * 2;
                const rVar = 0.55 + Math.random() * 0.30;  // [0.55, 0.85] — less extreme variation
                ctrl.push({
                    x: cx + Math.cos(angle) * rx * rVar,
                    y: cy + Math.sin(angle) * ry * rVar
                });
            }

            // Log the rVar spread to see how wild the radii are
            const radii = ctrl.map(p => Math.sqrt((p.x-cx)**2/(rx**2) + (p.y-cy)**2/(ry**2)));
            const rMin = Math.min(...radii).toFixed(2), rMax = Math.max(...radii).toFixed(2);
            console.log(`[track] attempt ${attempt+1}/14  numCtrl=${numCtrl}  rMin=${rMin} rMax=${rMax}`);

            // Only enforce ADJACENT pairs (110 px minimum).
            for (let iter = 0; iter < 6; iter++) {
                for (let i = 0; i < ctrl.length; i++) {
                    const next = ctrl[(i + 1) % ctrl.length];
                    const dx = next.x - ctrl[i].x, dy = next.y - ctrl[i].y;
                    const d = Math.sqrt(dx * dx + dy * dy);
                    if (d < 110) {
                        const mx = (ctrl[i].x + next.x) / 2;
                        const my = (ctrl[i].y + next.y) / 2;
                        ctrl[i].x += (ctrl[i].x - mx) * 0.4;
                        ctrl[i].y += (ctrl[i].y - my) * 0.4;
                        next.x += (next.x - mx) * 0.4;
                        next.y += (next.y - my) * 0.4;
                    }
                }
            }

            // Apply 2 passes of Chaikin's corner-cutting algorithm.
            // Each pass replaces every edge with two new points at 25% and 75%
            // of that edge, rounding off all sharp vertices.
            // Mathematical guarantee: after 2 passes, every interior angle ≥ 135°,
            // so no corner is ever tight enough to self-intersect the inner edge.
            // (8-12 ctrl points → 16-24 after pass 1 → 32-48 after pass 2)
            for (let pass = 0; pass < 2; pass++) {
                const smooth = [];
                const nc = ctrl.length;
                for (let i = 0; i < nc; i++) {
                    const a = ctrl[i], b = ctrl[(i + 1) % nc];
                    smooth.push({ x: a.x + 0.25*(b.x-a.x), y: a.y + 0.25*(b.y-a.y) });
                    smooth.push({ x: a.x + 0.75*(b.x-a.x), y: a.y + 0.75*(b.y-a.y) });
                }
                ctrl.length = 0;
                smooth.forEach(p => ctrl.push(p));
            }
            console.log(`[track] attempt ${attempt+1}/14 after Chaikin: ${ctrl.length} ctrl pts`);

            _debugCtrl = ctrl.map(p => ({ ...p }));  // store for overlay

            // Reject immediately if the control polygon itself self-intersects.
            const ctrlCross = _findCtrlCross(ctrl);
            if (ctrlCross) {
                console.log(`[track] attempt ${attempt+1}/14 CTRL POLYGON crosses: seg ${ctrlCross.i}→${ctrlCross.i+1} X seg ${ctrlCross.j}→${ctrlCross.j+1} — retrying`);
                continue;
            }

            points = catmullRomChain(ctrl, 15);  // 32-48 ctrl × 15 ≈ 500-700 pts total
            computeLength();

            // Check spline edge validity and report first crossing found
            const edgeCross = _findEdgeCross();
            if (!edgeCross) {
                validAttempt = attempt;
                break;
            }
            const frac = (edgeCross.i / points.length * 100).toFixed(1);
            console.log(`[track] attempt ${attempt+1}/14 SPLINE edge crosses: side=${edgeCross.sign>0?'+':'-'}  seg[${edgeCross.i}] X seg[${edgeCross.j}]  (~${frac}% around track) — retrying`);
        }

        if (validAttempt < 0) {
            console.warn('[track] all 14 attempts invalid — using last generated track (see debug overlay)');
        } else {
            console.log(`[track] valid track on attempt ${validAttempt + 1}`);
        }

        finishIndex = 0;
        return points;
    }

    /** Debug overlay: draws the control polygon and numbered control points. */
    function drawDebug(ctx) {
        if (!_debugCtrl.length) return;
        const n = _debugCtrl.length;

        // Draw control polygon
        ctx.save();
        ctx.setLineDash([8, 6]);
        ctx.strokeStyle = 'rgba(255,255,0,0.7)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(_debugCtrl[0].x, _debugCtrl[0].y);
        for (let i = 1; i < n; i++) ctx.lineTo(_debugCtrl[i].x, _debugCtrl[i].y);
        ctx.closePath();
        ctx.stroke();

        // Draw each control point as a labelled circle
        for (let i = 0; i < n; i++) {
            const p = _debugCtrl[i];
            ctx.beginPath();
            ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(255, 80, 80, 0.9)';
            ctx.fill();
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;
            ctx.setLineDash([]);
            ctx.stroke();

            ctx.fillStyle = '#fff';
            ctx.font = 'bold 11px monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(i, p.x, p.y);
        }
        ctx.restore();
    }

    /** Returns null if control polygon is valid, or {i,j} of first crossing segments. */
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

    /** Returns null if spline edges are valid, or {sign,i,j} of first crossing. */
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

    function _isTrackValid()    { return _findEdgeCross() === null; }

    function _segIntersect(p1, p2, p3, p4) {
        const d1x = p2.x - p1.x, d1y = p2.y - p1.y;
        const d2x = p4.x - p3.x, d2y = p4.y - p3.y;
        const denom = d1x * d2y - d1y * d2x;
        if (Math.abs(denom) < 1e-8) return false;
        const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
        const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denom;
        return t > 0.01 && t < 0.99 && u > 0.01 && u < 0.99;
    }

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
     * Centripetal Catmull-Rom (α = 0.5).
     *
     * Unlike uniform CR (α = 0), the centripetal variant parameterises each
     * segment by √(chord length) rather than a fixed step.  This eliminates
     * cusps and self-intersections when consecutive control points have very
     * different spacings — exactly the cause of the V-corner bug.
     *
     * Reference: Barry & Goldman (1988), "A recursive evaluation algorithm
     * for a class of Catmull–Rom splines".
     */
    function centripetalCR(p0, p1, p2, p3, t) {
        // Knot spacing: t_{i+1} - t_i = |P_{i+1} - P_i|^α, α = 0.5
        function knot(a, b) {
            const dx = b.x - a.x, dy = b.y - a.y;
            return Math.pow(dx * dx + dy * dy, 0.25); // (dist²)^0.25 = dist^0.5
        }

        const t0 = 0;
        const t1 = t0 + knot(p0, p1);
        const t2 = t1 + knot(p1, p2);
        const t3 = t2 + knot(p2, p3);

        // Guard against degenerate (coincident) control points
        if (Math.abs(t2 - t1) < 1e-8) return { x: p1.x, y: p1.y };

        // Remap input t ∈ [0, 1) to tp ∈ [t1, t2)
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
            const next = points[(i+1)%n];
            const dx = next.x - points[i].x, dy = next.y - points[i].y;
            totalLength += Math.sqrt(dx*dx + dy*dy);
        }
    }

    function normalAt(idx) {
        const n = points.length;
        const next = points[(idx+1)%n], prev = points[(idx-1+n)%n];
        const dx = next.x - prev.x, dy = next.y - prev.y;
        const len = Math.sqrt(dx*dx + dy*dy) || 1;
        return { x: -dy/len, y: dx/len };
    }

    function angleAt(idx) {
        const n = points.length;
        const next = points[(idx+1)%n], prev = points[(idx-1+n)%n];
        return Math.atan2(next.y - prev.y, next.x - prev.x);
    }

    function curvatureAt(idx) {
        const n = points.length;
        const look = 5;
        const p0 = points[(idx-look+n)%n], p1 = points[idx], p2 = points[(idx+look)%n];
        const dx1 = p1.x-p0.x, dy1 = p1.y-p0.y;
        const dx2 = p2.x-p1.x, dy2 = p2.y-p1.y;
        const cross = Math.abs(dx1*dy2 - dy1*dx2);
        const dot = Math.sqrt(dx1*dx1+dy1*dy1)*Math.sqrt(dx2*dx2+dy2*dy2);
        return dot > 0 ? cross/dot : 0;
    }

    function draw(ctx) {
        const n = points.length;
        if (n < 2) return;

        // Track shadow
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.5)';
        ctx.shadowBlur = 25;
        drawTrackPath(ctx, trackWidth + 12);
        ctx.fillStyle = '#2a2a2a';
        ctx.fill();
        ctx.restore();

        // Asphalt with gradient feel
        drawTrackPath(ctx, trackWidth);
        ctx.fillStyle = '#4a4a4a';
        ctx.fill();

        // Inner asphalt (lighter center strip)
        drawTrackPath(ctx, trackWidth * 0.7);
        ctx.fillStyle = '#525252';
        ctx.fill();

        // Racing line hint (subtle)
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

        // Track edge lines (solid white)
        drawEdgeLine(ctx, trackWidth / 2, 'rgba(255,255,255,0.5)', 2);
        drawEdgeLine(ctx, -trackWidth / 2, 'rgba(255,255,255,0.5)', 2);

        // Curbs at corners
        drawCurbs(ctx);
        drawFinishLine(ctx);
    }

    function drawTrackPath(ctx, width) {
        const n = points.length;
        const outer = [], inner = [];
        for (let i = 0; i < n; i++) {
            const norm = normalAt(i);
            outer.push({ x: points[i].x + norm.x*width/2, y: points[i].y + norm.y*width/2 });
            inner.push({ x: points[i].x - norm.x*width/2, y: points[i].y - norm.y*width/2 });
        }
        ctx.beginPath();
        ctx.moveTo(outer[0].x, outer[0].y);
        for (let i = 1; i < n; i++) ctx.lineTo(outer[i].x, outer[i].y);
        ctx.closePath();
        for (let i = n-1; i >= 0; i--) {
            if (i === n-1) ctx.moveTo(inner[i].x, inner[i].y);
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
            const px = points[i].x + norm.x * offset;
            const py = points[i].y + norm.y * offset;
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
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
            if (curv > 0.06) {
                const norm = normalAt(i);
                const intensity = Math.min(1, curv * 5);

                // At tight corners the inner-side marker falls on the road surface because
                // the inner radius is very small. Compute which side is outer via cross
                // product, then skip the inner side if the corner is tight.
                const look = 5;
                const p0 = points[(i - look + n) % n];
                const p2 = points[(i + look) % n];
                const cross = (points[i].x - p0.x) * (p2.y - points[i].y) -
                              (points[i].y - p0.y) * (p2.x - points[i].x);
                // outerSide: the side the road bends away from (positive = +norm direction)
                const outerSide = cross >= 0 ? 1 : -1;

                for (const side of [1, -1]) {
                    // For tight corners, skip inner-side marker — it would overlap the road
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
        // Checkerboard
        const steps = 10;
        const angle = Math.atan2(ey - sy, ex - sx);
        const perpX = Math.cos(angle + Math.PI/2);
        const perpY = Math.sin(angle + Math.PI/2);
        for (let i = 0; i < steps; i++) {
            for (let row = 0; row < 2; row++) {
                const f = i / steps;
                const x1 = sx + (ex - sx) * f;
                const y1 = sy + (ey - sy) * f;
                ctx.fillStyle = (i + row) % 2 === 0 ? '#fff' : '#111';
                ctx.save();
                ctx.translate(x1 + perpX * row * 5, y1 + perpY * row * 5);
                ctx.rotate(angle);
                const segW = Math.sqrt((ex-sx)**2 + (ey-sy)**2) / steps;
                ctx.fillRect(0, -2.5, segW + 0.5, 5);
                ctx.restore();
            }
        }
        ctx.restore();
    }

    function getPositionAt(progress, laneOffset) {
        const n = points.length;
        const frac = (((progress % 1) + 1) % 1);
        const exactIdx = frac * n;
        const idx = Math.floor(exactIdx);
        const t = exactIdx - idx;
        const p1 = points[idx % n], p2 = points[(idx+1) % n];
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
            const d = dx*dx + dy*dy;
            if (d < bestDist) { bestDist = d; bestIdx = i; }
        }
        const start = (bestIdx - 8 + n) % n;
        bestDist = Infinity;
        for (let j = 0; j < 16; j++) {
            const i = (start + j) % n;
            const dx = points[i].x - wx, dy = points[i].y - wy;
            const d = dx*dx + dy*dy;
            if (d < bestDist) { bestDist = d; bestIdx = i; }
        }
        return { index: bestIdx, progress: bestIdx / n, dist: Math.sqrt(bestDist) };
    }

    function getTrackLength() { return totalLength; }
    function getPoints() { return points; }
    function getWidth() { return trackWidth; }
    function getPointCount() { return points.length; }

    return {
        generate, draw, drawDebug, getPositionAt, getTrackLength,
        getPoints, getWidth, angleAt, normalAt, curvatureAt,
        closestPoint, getPointCount
    };
})();
