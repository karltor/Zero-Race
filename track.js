/**
 * Procedural track generation and rendering.
 * Generates a closed circuit using control points and catmull-rom splines.
 */
const Track = (() => {
    let points = [];       // center-line points [{x, y}]
    let trackWidth = 48;
    let finishIndex = 0;

    /**
     * Generate a new random track that fits within the given bounds.
     */
    function generate(w, h) {
        const cx = w / 2;
        const cy = h / 2;
        const margin = 120;
        const rx = (w - margin * 2) / 2;
        const ry = (h - margin * 2) / 2;

        // Place 8-14 control points around an ellipse with random offsets
        const numCtrl = 8 + Math.floor(Math.random() * 7);
        const ctrl = [];
        for (let i = 0; i < numCtrl; i++) {
            const angle = (i / numCtrl) * Math.PI * 2;
            const rVar = 0.6 + Math.random() * 0.4;
            ctrl.push({
                x: cx + Math.cos(angle) * rx * rVar,
                y: cy + Math.sin(angle) * ry * rVar
            });
        }

        // Smooth with catmull-rom spline
        points = catmullRomChain(ctrl, 30);
        finishIndex = 0;
        return points;
    }

    /**
     * Catmull-rom spline through closed loop of control points.
     */
    function catmullRomChain(ctrl, segPoints) {
        const result = [];
        const n = ctrl.length;
        for (let i = 0; i < n; i++) {
            const p0 = ctrl[(i - 1 + n) % n];
            const p1 = ctrl[i];
            const p2 = ctrl[(i + 1) % n];
            const p3 = ctrl[(i + 2) % n];
            for (let t = 0; t < segPoints; t++) {
                const f = t / segPoints;
                result.push(catmullRomPoint(p0, p1, p2, p3, f));
            }
        }
        return result;
    }

    function catmullRomPoint(p0, p1, p2, p3, t) {
        const t2 = t * t;
        const t3 = t2 * t;
        return {
            x: 0.5 * (
                2 * p1.x +
                (-p0.x + p2.x) * t +
                (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
                (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3
            ),
            y: 0.5 * (
                2 * p1.y +
                (-p0.y + p2.y) * t +
                (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
                (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3
            )
        };
    }

    /**
     * Get normal at a given point index.
     */
    function normalAt(idx) {
        const n = points.length;
        const next = points[(idx + 1) % n];
        const prev = points[(idx - 1 + n) % n];
        const dx = next.x - prev.x;
        const dy = next.y - prev.y;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        return { x: -dy / len, y: dx / len };
    }

    /**
     * Get tangent angle at a given point index.
     */
    function angleAt(idx) {
        const n = points.length;
        const next = points[(idx + 1) % n];
        const prev = points[(idx - 1 + n) % n];
        return Math.atan2(next.y - prev.y, next.x - prev.x);
    }

    /**
     * Render the track onto a canvas context.
     */
    function draw(ctx) {
        const n = points.length;
        if (n < 2) return;

        // Outer grass is already the canvas bg

        // Track shadow
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.4)';
        ctx.shadowBlur = 20;
        drawTrackPath(ctx, trackWidth + 8);
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
        for (let i = 1; i < n; i++) {
            ctx.lineTo(points[i].x, points[i].y);
        }
        ctx.closePath();
        ctx.stroke();
        ctx.restore();

        // Track borders (curbs)
        drawBorder(ctx, trackWidth / 2, '#cc2222', '#ffffff');
        drawBorder(ctx, -trackWidth / 2, '#cc2222', '#ffffff');

        // Start/finish line
        drawFinishLine(ctx);

        // Rumble strips at tight corners
        drawRumbleStrips(ctx);
    }

    function drawTrackPath(ctx, width) {
        const n = points.length;
        // Build outer and inner edges
        const outer = [];
        const inner = [];
        for (let i = 0; i < n; i++) {
            const norm = normalAt(i);
            outer.push({
                x: points[i].x + norm.x * width / 2,
                y: points[i].y + norm.y * width / 2
            });
            inner.push({
                x: points[i].x - norm.x * width / 2,
                y: points[i].y - norm.y * width / 2
            });
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

    function drawBorder(ctx, offset, c1, c2) {
        const n = points.length;
        ctx.save();
        ctx.lineWidth = 4;
        const segLen = 8;
        let accum = 0;
        let colorIdx = 0;

        ctx.beginPath();
        for (let i = 0; i < n; i++) {
            const norm = normalAt(i);
            const px = points[i].x + norm.x * offset;
            const py = points[i].y + norm.y * offset;

            if (i === 0) {
                ctx.moveTo(px, py);
            } else {
                const prev = points[i - 1];
                const pNorm = normalAt(i - 1);
                const ppx = prev.x + pNorm.x * offset;
                const ppy = prev.y + pNorm.y * offset;
                const dx = px - ppx;
                const dy = py - ppy;
                accum += Math.sqrt(dx * dx + dy * dy);

                if (accum > segLen) {
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
        }
        ctx.strokeStyle = colorIdx % 2 === 0 ? c1 : c2;
        ctx.stroke();
        ctx.restore();
    }

    function drawFinishLine(ctx) {
        const idx = finishIndex;
        const norm = normalAt(idx);
        const hw = trackWidth / 2;
        const sx = points[idx].x + norm.x * hw;
        const sy = points[idx].y + norm.y * hw;
        const ex = points[idx].x - norm.x * hw;
        const ey = points[idx].y - norm.y * hw;

        ctx.save();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(ex, ey);
        ctx.stroke();

        // Checkered pattern
        const steps = 8;
        for (let i = 0; i < steps; i++) {
            const f1 = i / steps;
            const f2 = (i + 1) / steps;
            const x1 = sx + (ex - sx) * f1;
            const y1 = sy + (ey - sy) * f1;
            const x2 = sx + (ex - sx) * f2;
            const y2 = sy + (ey - sy) * f2;
            ctx.fillStyle = i % 2 === 0 ? '#fff' : '#222';
            ctx.fillRect(
                Math.min(x1, x2) - 2, Math.min(y1, y2) - 2,
                Math.abs(x2 - x1) + 4, Math.abs(y2 - y1) + 4
            );
        }
        ctx.restore();
    }

    function drawRumbleStrips(ctx) {
        const n = points.length;
        ctx.save();
        for (let i = 0; i < n; i += 2) {
            // Measure curvature
            const prev = points[(i - 3 + n) % n];
            const curr = points[i];
            const next = points[(i + 3) % n];
            const dx1 = curr.x - prev.x, dy1 = curr.y - prev.y;
            const dx2 = next.x - curr.x, dy2 = next.y - curr.y;
            const cross = Math.abs(dx1 * dy2 - dy1 * dx2);

            if (cross > 15) {
                const norm = normalAt(i);
                for (const side of [1, -1]) {
                    const off = (trackWidth / 2 + 3) * side;
                    const rx = points[i].x + norm.x * off;
                    const ry = points[i].y + norm.y * off;
                    ctx.fillStyle = (i / 2) % 2 === 0 ? '#cc2222' : '#ffcc00';
                    ctx.fillRect(rx - 3, ry - 3, 6, 6);
                }
            }
        }
        ctx.restore();
    }

    /**
     * Get the position and angle for a car at a given fractional progress [0..1).
     */
    function getPositionAt(progress, laneOffset) {
        const n = points.length;
        const exactIdx = ((progress % 1) + 1) % 1 * n;
        const idx = Math.floor(exactIdx);
        const frac = exactIdx - idx;

        const p1 = points[idx % n];
        const p2 = points[(idx + 1) % n];
        const x = p1.x + (p2.x - p1.x) * frac;
        const y = p1.y + (p2.y - p1.y) * frac;
        const angle = angleAt(idx);

        const norm = normalAt(idx);
        return {
            x: x + norm.x * laneOffset,
            y: y + norm.y * laneOffset,
            angle: angle
        };
    }

    function getTrackLength() {
        let len = 0;
        const n = points.length;
        for (let i = 0; i < n; i++) {
            const next = points[(i + 1) % n];
            const dx = next.x - points[i].x;
            const dy = next.y - points[i].y;
            len += Math.sqrt(dx * dx + dy * dy);
        }
        return len;
    }

    function getPoints() { return points; }
    function getWidth() { return trackWidth; }

    return {
        generate, draw, getPositionAt, getTrackLength,
        getPoints, getWidth, angleAt, normalAt
    };
})();
