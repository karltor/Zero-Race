/**
 * Procedural track generation and rendering.
 * Generates a closed circuit using control points and catmull-rom splines.
 */
const Track = (() => {
    let points = [];       // center-line points [{x, y}]
    let trackWidth = 90;
    let finishIndex = 0;
    let totalLength = 0;
    let cumLengths = [];   // cumulative arc-length at each point

    function generate(w, h) {
        const cx = w / 2;
        const cy = h / 2;
        const margin = 140;
        const rx = (w - margin * 2) / 2;
        const ry = (h - margin * 2) / 2;

        const numCtrl = 8 + Math.floor(Math.random() * 5);
        const ctrl = [];
        for (let i = 0; i < numCtrl; i++) {
            const angle = (i / numCtrl) * Math.PI * 2;
            const rVar = 0.65 + Math.random() * 0.35;
            ctrl.push({
                x: cx + Math.cos(angle) * rx * rVar,
                y: cy + Math.sin(angle) * ry * rVar
            });
        }

        points = catmullRomChain(ctrl, 40);
        finishIndex = 0;
        computeLengths();
        return points;
    }

    function catmullRomChain(ctrl, segPoints) {
        const result = [];
        const n = ctrl.length;
        for (let i = 0; i < n; i++) {
            const p0 = ctrl[(i - 1 + n) % n];
            const p1 = ctrl[i];
            const p2 = ctrl[(i + 1) % n];
            const p3 = ctrl[(i + 2) % n];
            for (let t = 0; t < segPoints; t++) {
                result.push(catmullRomPoint(p0, p1, p2, p3, t / segPoints));
            }
        }
        return result;
    }

    function catmullRomPoint(p0, p1, p2, p3, t) {
        const t2 = t * t, t3 = t2 * t;
        return {
            x: 0.5 * (2*p1.x + (-p0.x+p2.x)*t + (2*p0.x-5*p1.x+4*p2.x-p3.x)*t2 + (-p0.x+3*p1.x-3*p2.x+p3.x)*t3),
            y: 0.5 * (2*p1.y + (-p0.y+p2.y)*t + (2*p0.y-5*p1.y+4*p2.y-p3.y)*t2 + (-p0.y+3*p1.y-3*p2.y+p3.y)*t3)
        };
    }

    function computeLengths() {
        cumLengths = [0];
        totalLength = 0;
        const n = points.length;
        for (let i = 1; i <= n; i++) {
            const prev = points[i - 1];
            const curr = points[i % n];
            const dx = curr.x - prev.x, dy = curr.y - prev.y;
            totalLength += Math.sqrt(dx * dx + dy * dy);
            cumLengths.push(totalLength);
        }
    }

    function normalAt(idx) {
        const n = points.length;
        const next = points[(idx + 1) % n];
        const prev = points[(idx - 1 + n) % n];
        const dx = next.x - prev.x, dy = next.y - prev.y;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        return { x: -dy / len, y: dx / len };
    }

    function angleAt(idx) {
        const n = points.length;
        const next = points[(idx + 1) % n];
        const prev = points[(idx - 1 + n) % n];
        return Math.atan2(next.y - prev.y, next.x - prev.x);
    }

    /** Get curvature (0 = straight, higher = tighter) at a point index. */
    function curvatureAt(idx) {
        const n = points.length;
        const look = 4;
        const p0 = points[(idx - look + n) % n];
        const p1 = points[idx];
        const p2 = points[(idx + look) % n];
        const dx1 = p1.x - p0.x, dy1 = p1.y - p0.y;
        const dx2 = p2.x - p1.x, dy2 = p2.y - p1.y;
        const cross = Math.abs(dx1 * dy2 - dy1 * dx2);
        const dot = Math.sqrt(dx1*dx1+dy1*dy1) * Math.sqrt(dx2*dx2+dy2*dy2);
        return dot > 0 ? cross / dot : 0;
    }

    function draw(ctx) {
        const n = points.length;
        if (n < 2) return;

        // Track shadow
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.4)';
        ctx.shadowBlur = 20;
        drawTrackPath(ctx, trackWidth + 10);
        ctx.fillStyle = '#333';
        ctx.fill();
        ctx.restore();

        // Asphalt
        drawTrackPath(ctx, trackWidth);
        ctx.fillStyle = '#555';
        ctx.fill();

        // Center dashes
        ctx.save();
        ctx.setLineDash([12, 18]);
        ctx.strokeStyle = '#777';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < n; i++) ctx.lineTo(points[i].x, points[i].y);
        ctx.closePath();
        ctx.stroke();
        ctx.restore();

        // Curbs
        drawBorder(ctx, trackWidth / 2, '#cc2222', '#ffffff');
        drawBorder(ctx, -trackWidth / 2, '#cc2222', '#ffffff');

        // Finish line
        drawFinishLine(ctx);
        drawRumbleStrips(ctx);
    }

    function drawTrackPath(ctx, width) {
        const n = points.length;
        const outer = [], inner = [];
        for (let i = 0; i < n; i++) {
            const norm = normalAt(i);
            outer.push({ x: points[i].x + norm.x * width/2, y: points[i].y + norm.y * width/2 });
            inner.push({ x: points[i].x - norm.x * width/2, y: points[i].y - norm.y * width/2 });
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

    function drawBorder(ctx, offset, c1, c2) {
        const n = points.length;
        ctx.save();
        ctx.lineWidth = 4;
        let accum = 0, colorIdx = 0;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
            const norm = normalAt(i);
            const px = points[i].x + norm.x * offset;
            const py = points[i].y + norm.y * offset;
            if (i === 0) { ctx.moveTo(px, py); continue; }
            const pNorm = normalAt(i-1);
            const ppx = points[i-1].x + pNorm.x * offset;
            const ppy = points[i-1].y + pNorm.y * offset;
            accum += Math.sqrt((px-ppx)**2 + (py-ppy)**2);
            if (accum > 8) {
                accum = 0;
                ctx.strokeStyle = colorIdx % 2 === 0 ? c1 : c2;
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(px, py);
                colorIdx++;
            } else {
                ctx.lineTo(px, py);
            }
        }
        ctx.strokeStyle = colorIdx % 2 === 0 ? c1 : c2;
        ctx.stroke();
        ctx.restore();
    }

    function drawFinishLine(ctx) {
        const norm = normalAt(finishIndex);
        const hw = trackWidth / 2;
        const p = points[finishIndex];
        const sx = p.x + norm.x * hw, sy = p.y + norm.y * hw;
        const ex = p.x - norm.x * hw, ey = p.y - norm.y * hw;
        ctx.save();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 6;
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
        const steps = 8;
        for (let i = 0; i < steps; i++) {
            const f = i / steps, f2 = (i+1) / steps;
            const x1 = sx+(ex-sx)*f, y1 = sy+(ey-sy)*f;
            const x2 = sx+(ex-sx)*f2, y2 = sy+(ey-sy)*f2;
            ctx.fillStyle = i%2===0 ? '#fff' : '#222';
            ctx.fillRect(Math.min(x1,x2)-2, Math.min(y1,y2)-2,
                Math.abs(x2-x1)+4, Math.abs(y2-y1)+4);
        }
        ctx.restore();
    }

    function drawRumbleStrips(ctx) {
        const n = points.length;
        ctx.save();
        for (let i = 0; i < n; i += 2) {
            const curv = curvatureAt(i);
            if (curv > 0.08) {
                const norm = normalAt(i);
                for (const side of [1, -1]) {
                    const off = (trackWidth/2 + 3) * side;
                    ctx.fillStyle = (i/2)%2===0 ? '#cc2222' : '#ffcc00';
                    ctx.fillRect(points[i].x + norm.x*off - 3,
                        points[i].y + norm.y*off - 3, 6, 6);
                }
            }
        }
        ctx.restore();
    }

    /**
     * Convert fractional progress [0..1) to world position + angle.
     * laneOffset is in pixels from center.
     */
    function getPositionAt(progress, laneOffset) {
        const n = points.length;
        const frac = (((progress % 1) + 1) % 1);
        const exactIdx = frac * n;
        const idx = Math.floor(exactIdx);
        const t = exactIdx - idx;
        const p1 = points[idx % n];
        const p2 = points[(idx + 1) % n];
        const x = p1.x + (p2.x - p1.x) * t;
        const y = p1.y + (p2.y - p1.y) * t;
        const angle = angleAt(idx);
        const norm = normalAt(idx);
        return {
            x: x + norm.x * laneOffset,
            y: y + norm.y * laneOffset,
            angle
        };
    }

    /** Find closest point index and progress for a world position. */
    function closestPoint(wx, wy) {
        const n = points.length;
        let bestDist = Infinity, bestIdx = 0;
        // Coarse search every 4th point
        for (let i = 0; i < n; i += 4) {
            const dx = points[i].x - wx, dy = points[i].y - wy;
            const d = dx*dx + dy*dy;
            if (d < bestDist) { bestDist = d; bestIdx = i; }
        }
        // Refine around best
        const start = (bestIdx - 6 + n) % n;
        bestDist = Infinity;
        for (let j = 0; j < 12; j++) {
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
        generate, draw, getPositionAt, getTrackLength,
        getPoints, getWidth, angleAt, normalAt, curvatureAt,
        closestPoint, getPointCount
    };
})();
