/**
 * Procedural track generation and rendering.
 * Uses catmull-rom splines for smooth curves. Track fills available space.
 */
const Track = (() => {
    let points = [];
    let trackWidth = 150;
    let finishIndex = 0;
    let totalLength = 0;

    function generate(w, h) {
        const cx = w / 2;
        const cy = h / 2;
        const margin = 35;
        const rx = (w - margin * 2) / 2;
        const ry = (h - margin * 2) / 2;

        const numCtrl = 8 + Math.floor(Math.random() * 5);
        const ctrl = [];
        for (let i = 0; i < numCtrl; i++) {
            const angle = (i / numCtrl) * Math.PI * 2;
            const rVar = 0.6 + Math.random() * 0.4;
            ctrl.push({
                x: cx + Math.cos(angle) * rx * rVar,
                y: cy + Math.sin(angle) * ry * rVar
            });
        }

        // Ensure minimum distance between control points
        for (let iter = 0; iter < 3; iter++) {
            for (let i = 0; i < ctrl.length; i++) {
                const next = ctrl[(i + 1) % ctrl.length];
                const dx = next.x - ctrl[i].x, dy = next.y - ctrl[i].y;
                const d = Math.sqrt(dx * dx + dy * dy);
                if (d < 80) {
                    const mx = (ctrl[i].x + next.x) / 2;
                    const my = (ctrl[i].y + next.y) / 2;
                    ctrl[i].x += (ctrl[i].x - mx) * 0.3;
                    ctrl[i].y += (ctrl[i].y - my) * 0.3;
                    next.x += (next.x - mx) * 0.3;
                    next.y += (next.y - my) * 0.3;
                }
            }
        }

        points = catmullRomChain(ctrl, 50);
        finishIndex = 0;
        computeLength();
        return points;
    }

    function catmullRomChain(ctrl, segPts) {
        const result = [];
        const n = ctrl.length;
        for (let i = 0; i < n; i++) {
            const p0 = ctrl[(i-1+n)%n], p1 = ctrl[i];
            const p2 = ctrl[(i+1)%n], p3 = ctrl[(i+2)%n];
            for (let t = 0; t < segPts; t++) {
                result.push(catmullRom(p0, p1, p2, p3, t / segPts));
            }
        }
        return result;
    }

    function catmullRom(p0, p1, p2, p3, t) {
        const t2 = t*t, t3 = t2*t;
        return {
            x: 0.5*(2*p1.x+(-p0.x+p2.x)*t+(2*p0.x-5*p1.x+4*p2.x-p3.x)*t2+(-p0.x+3*p1.x-3*p2.x+p3.x)*t3),
            y: 0.5*(2*p1.y+(-p0.y+p2.y)*t+(2*p0.y-5*p1.y+4*p2.y-p3.y)*t2+(-p0.y+3*p1.y-3*p2.y+p3.y)*t3)
        };
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
                for (const side of [1, -1]) {
                    const off = (trackWidth/2 + 1) * side;
                    const px = points[i].x + norm.x * off;
                    const py = points[i].y + norm.y * off;
                    ctx.fillStyle = Math.floor(i/3) % 2 === 0
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
        generate, draw, getPositionAt, getTrackLength,
        getPoints, getWidth, angleAt, normalAt, curvatureAt,
        closestPoint, getPointCount
    };
})();
