/**
 * Broadcast HUD — everything drawn in screen space, on top of the camera view.
 *
 *   left    timing tower (position, tyre, gap, DRS/pit flags)
 *   top     lap counter, circuit name, flag status, weather
 *   right   minimap + race clock + seed
 *   bottom  commentary subtitles and the event ticker
 *   centre  big captions when something happens
 */
const Hud = (() => {

    let W = 1280, H = 720, S = 1;      // S = UI scale factor
    let minimap = null;                // {pts, minX, minY, scale, w, h}
    let caption = null;                // {text, color, until, born}
    const flash = [];                  // transient side notifications

    const FONT = 'Rajdhani, "Segoe UI", Arial, sans-serif';

    function resize(w, h) {
        W = w; H = h;
        S = Math.max(0.72, Math.min(1.35, h / 900));
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    function rrect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
        ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
        ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
        ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
        ctx.closePath();
    }

    function fmtTime(ms) {
        if (!ms || !Number.isFinite(ms)) return '--.---';
        const m = Math.floor(ms / 60000);
        const s = (ms % 60000) / 1000;
        return m > 0 ? `${m}:${s.toFixed(3).padStart(6, '0')}` : s.toFixed(3);
    }

    function fmtClock(ms) {
        const total = Math.floor(ms / 1000);
        return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
    }

    function teamColor(team) {
        return (CarSVG.TEAM_COLORS[team] || { light: '#fff', main: '#888' });
    }

    // -------------------------------------------------------------------------
    // Captions & flashes
    // -------------------------------------------------------------------------

    function showCaption(text, color, ms = 2200) {
        const now = performance.now();
        caption = { text, color: color || '#fff', born: now, until: now + ms };
    }

    function pushFlash(text, color) {
        flash.unshift({ text, color: color || '#fff', born: performance.now() });
        if (flash.length > 6) flash.pop();
    }

    /** Called by the race layer for every event that fires during playback. */
    function onEvent(e) {
        const badge = Commentary.BADGES[e.type];
        const bigOnes = new Set(['overtake', 'lead_change', 'crash', 'spin', 'dnf',
                                 'sc_deploy', 'sc_end', 'weather_change', 'final_lap',
                                 'chequered', 'fastest_lap', 'mech_issue']);
        if (badge && bigOnes.has(e.type)) {
            showCaption(badge.text, badge.color, e.type === 'final_lap' ? 3200 : 2100);
        }
        if (badge) pushFlash(_flashText(e), badge.color);
    }

    function _flashText(e) {
        const d = e.data || {};
        switch (e.type) {
            case 'overtake':      return `${d.name} → P${d.position}`;
            case 'lead_change':   return `${d.name} leads`;
            case 'fastest_lap':   return `${d.name}  ${fmtTime(d.time)}`;
            case 'pit_enter':     return `${d.name} pits (${d.compound})`;
            case 'pit_exit':      return `${d.name} out, P${d.position}`;
            case 'spin':          return `${d.name} spins`;
            case 'crash':         return `${d.name} × ${d.otherName}`;
            case 'contact':       return `${d.name} × ${d.otherName}`;
            case 'dnf':           return `${d.name} OUT — ${d.reason}`;
            case 'mech_issue':    return `${d.name} ${d.issue}`;
            case 'sc_deploy':     return 'SAFETY CAR DEPLOYED';
            case 'sc_end':        return 'GREEN FLAG';
            case 'weather_change':return `Weather: ${d.to}`;
            case 'final_lap':     return 'FINAL LAP';
            case 'battle':        return `${d.name} attacking ${d.aheadName}`;
            case 'tyre_critical': return `${d.name} tyres critical`;
            default:              return e.type;
        }
    }

    // -------------------------------------------------------------------------
    // Minimap
    // -------------------------------------------------------------------------

    function buildMinimap(boxW, boxH) {
        const pts = Track.getPoints();
        if (!pts.length) { minimap = null; return; }
        const boxKey = `${Math.round(boxW)}x${Math.round(boxH)}x${pts.length}`;
        const b = Track.getBounds();
        const wSpan = b.maxX - b.minX, hSpan = b.maxY - b.minY;
        const scale = Math.min(boxW / wSpan, boxH / hSpan);
        minimap = {
            pts, minX: b.minX, minY: b.minY, scale, boxKey,
            w: wSpan * scale, h: hSpan * scale,
        };
    }

    function _mapPt(p) {
        return { x: (p.x - minimap.minX) * minimap.scale, y: (p.y - minimap.minY) * minimap.scale };
    }

    function drawMinimap(ctx, sim) {
        const boxW = 210 * S, boxH = 150 * S;
        const boxKey = `${Math.round(boxW)}x${Math.round(boxH)}x${Track.getPointCount()}`;
        if (!minimap || minimap.boxKey !== boxKey) buildMinimap(boxW, boxH);
        if (!minimap) return;

        const x = W - minimap.w - 26 * S;
        const y = H - minimap.h - 26 * S;

        ctx.save();
        ctx.globalAlpha = 0.85;
        rrect(ctx, x - 12 * S, y - 12 * S, minimap.w + 24 * S, minimap.h + 24 * S, 8);
        ctx.fillStyle = 'rgba(8,10,20,0.72)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.translate(x, y);

        // Track ribbon
        ctx.beginPath();
        const step = Math.max(1, Math.floor(minimap.pts.length / 220));
        for (let i = 0; i < minimap.pts.length; i += step) {
            const p = _mapPt(minimap.pts[i]);
            ctx.lineTo(p.x, p.y);
        }
        ctx.closePath();
        ctx.strokeStyle = 'rgba(255,255,255,0.30)';
        ctx.lineWidth = Math.max(2.5, 5 * S);
        ctx.lineJoin = 'round';
        ctx.stroke();

        // Start/finish tick
        const sp = _mapPt(minimap.pts[0]);
        ctx.fillStyle = '#fff';
        ctx.fillRect(sp.x - 2, sp.y - 2, 4, 4);

        // Cars
        for (const c of sim.cars) {
            if (c.retired) continue;
            const p = _mapPt(c);
            const col = teamColor(c.team);
            ctx.beginPath();
            ctx.arc(p.x, p.y, c.position === 1 ? 4.4 * S : 3.3 * S, 0, Math.PI * 2);
            ctx.fillStyle = col.light;
            ctx.fill();
            if (c.position === 1) {
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 1.2;
                ctx.stroke();
            }
        }

        // Camera viewport rectangle
        const zoom = Camera.getZoom();
        const tl = Camera.screenToWorld(0, 0);
        const br = Camera.screenToWorld(W, H);
        const a = _mapPt(tl), bpt = _mapPt(br);
        if (zoom > 1.05) {
            ctx.strokeStyle = 'rgba(255,215,0,0.65)';
            ctx.lineWidth = 1.2;
            ctx.strokeRect(a.x, a.y, bpt.x - a.x, bpt.y - a.y);
        }

        ctx.restore();
    }

    // -------------------------------------------------------------------------
    // Timing tower
    // -------------------------------------------------------------------------

    function drawTower(ctx, sim) {
        const order = sim.state.order || sim.cars;
        const rowH = 30 * S;
        const w = 250 * S;
        const x = 22 * S;
        const y = 108 * S;

        ctx.save();
        ctx.textBaseline = 'middle';

        // Header
        rrect(ctx, x, y - 26 * S, w, 22 * S, 4);
        ctx.fillStyle = 'rgba(8,10,20,0.8)';
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.font = `bold ${10 * S}px ${FONT}`;
        ctx.textAlign = 'left';
        ctx.fillText('POS   DRIVER', x + 10 * S, y - 15 * S);
        ctx.textAlign = 'right';
        ctx.fillText('INTERVAL', x + w - 10 * S, y - 15 * S);

        for (let i = 0; i < order.length; i++) {
            const c = order[i];
            const ry = y + i * (rowH + 2 * S);
            const col = teamColor(c.team);
            const isLeader = i === 0;

            rrect(ctx, x, ry, w, rowH, 4);
            ctx.fillStyle = c.retired ? 'rgba(40,10,10,0.72)'
                          : isLeader ? 'rgba(255,215,0,0.16)'
                          : (i % 2 ? 'rgba(10,14,26,0.68)' : 'rgba(16,20,34,0.68)');
            ctx.fill();

            // Team stripe
            ctx.fillStyle = col.main;
            ctx.fillRect(x, ry, 4 * S, rowH);

            // Position
            ctx.textAlign = 'left';
            ctx.fillStyle = isLeader ? '#ffd700' : 'rgba(255,255,255,0.55)';
            ctx.font = `bold ${13 * S}px ${FONT}`;
            ctx.fillText(String(i + 1), x + 12 * S, ry + rowH / 2);

            // Name
            ctx.fillStyle = c.retired ? 'rgba(255,140,140,0.65)' : '#fff';
            ctx.font = `bold ${13 * S}px ${FONT}`;
            ctx.fillText(c.name, x + 32 * S, ry + rowH / 2);

            // Tyre pill
            const tx = x + 132 * S;
            ctx.beginPath();
            ctx.arc(tx, ry + rowH / 2, 8 * S, 0, Math.PI * 2);
            ctx.strokeStyle = c.tyre.color;
            ctx.lineWidth = 2.4 * S;
            ctx.stroke();
            ctx.fillStyle = `rgba(0,0,0,0.45)`;
            ctx.fill();
            ctx.fillStyle = c.tyre.color;
            ctx.font = `bold ${9 * S}px ${FONT}`;
            ctx.textAlign = 'center';
            ctx.fillText(c.tyre.short, tx, ry + rowH / 2 + 0.5);

            // Wear bar under the pill
            const wearW = 16 * S;
            ctx.fillStyle = 'rgba(255,255,255,0.14)';
            ctx.fillRect(tx - wearW / 2, ry + rowH - 5 * S, wearW, 2.2 * S);
            const wf = Math.min(1, c.tyreWear);
            ctx.fillStyle = wf > 0.8 ? '#ff5252' : wf > 0.55 ? '#ffb300' : '#4ade80';
            ctx.fillRect(tx - wearW / 2, ry + rowH - 5 * S, wearW * (1 - wf), 2.2 * S);

            // Status flags
            let fx = x + 150 * S;
            ctx.textAlign = 'left';
            ctx.font = `bold ${9 * S}px ${FONT}`;
            if (c.drsActive)  { ctx.fillStyle = '#4fe3ff'; ctx.fillText('DRS', fx, ry + rowH / 2); fx += 24 * S; }
            if (c.inPitLane)  { ctx.fillStyle = '#ffd54f'; ctx.fillText('PIT', fx, ry + rowH / 2); fx += 22 * S; }
            if (c.damage > 0.35 && !c.retired) { ctx.fillStyle = '#ff8a65'; ctx.fillText('DMG', fx, ry + rowH / 2); }

            // Interval
            ctx.textAlign = 'right';
            ctx.font = `${12 * S}px ${FONT}`;
            let gapText;
            if (sim.phase === 'qual') {
                if (c.qualifyingTime) { gapText = fmtTime(c.qualifyingTime); ctx.fillStyle = '#ffd700'; }
                else { gapText = c._qualPhase >= 1 ? 'FLYING' : 'OUT LAP'; ctx.fillStyle = 'rgba(255,255,255,0.45)'; }
            }
            else if (c.retired) { gapText = 'DNF'; ctx.fillStyle = '#ff6b6b'; }
            else if (i === 0) { gapText = 'LEADER'; ctx.fillStyle = '#ffd700'; }
            else if (!Number.isFinite(c.gapAheadSec)) { gapText = '--'; ctx.fillStyle = 'rgba(255,255,255,0.4)'; }
            else if (c.gapAheadSec > 60) { gapText = '+1 LAP'; ctx.fillStyle = 'rgba(255,255,255,0.5)'; }
            else { gapText = `+${c.gapAheadSec.toFixed(3)}`; ctx.fillStyle = c.gapAheadSec < 1 ? '#4fe3ff' : 'rgba(255,255,255,0.8)'; }
            ctx.fillText(gapText, x + w - 10 * S, ry + rowH / 2);
        }
        ctx.restore();
    }

    // -------------------------------------------------------------------------
    // Top bar
    // -------------------------------------------------------------------------

    function drawTopBar(ctx, sim, meta) {
        const barH = 62 * S;
        ctx.save();

        const grad = ctx.createLinearGradient(0, 0, 0, barH);
        grad.addColorStop(0, 'rgba(6,8,18,0.9)');
        grad.addColorStop(1, 'rgba(6,8,18,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, barH);

        ctx.textBaseline = 'middle';

        // Left — event branding
        ctx.textAlign = 'left';
        ctx.fillStyle = '#e94560';
        ctx.font = `bold ${21 * S}px ${FONT}`;
        ctx.fillText('ZERO RACE', 22 * S, 26 * S);
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.font = `${11 * S}px ${FONT}`;
        ctx.fillText(`${Track.getName()}  ·  Round ${meta.raceNumber}`, 22 * S, 45 * S);

        // Centre — lap counter
        const lap = sim.state.lapOfLeader || 1;
        ctx.textAlign = 'center';
        ctx.fillStyle = '#fff';
        ctx.font = `bold ${26 * S}px ${FONT}`;
        ctx.fillText(`LAP ${lap} / ${sim.state.totalLaps}`, W / 2, 26 * S);

        // Flag status
        const flag = sim.state.flag;
        if (flag !== 'green') {
            const fc = flag === 'sc' ? '#ffcc00' : flag === 'chequered' ? '#ffffff' : '#ffe066';
            const label = flag === 'sc' ? 'SAFETY CAR' : flag === 'chequered' ? 'CHEQUERED FLAG' : 'YELLOW';
            const pulse = 0.6 + 0.4 * Math.sin(performance.now() * 0.006);
            ctx.globalAlpha = pulse;
            ctx.fillStyle = fc;
            ctx.font = `bold ${13 * S}px ${FONT}`;
            ctx.fillText(label, W / 2, 47 * S);
            ctx.globalAlpha = 1;
        } else {
            ctx.fillStyle = 'rgba(255,255,255,0.35)';
            ctx.font = `${11 * S}px ${FONT}`;
            ctx.fillText(fmtClock(sim.state.raceTime), W / 2, 46 * S);
        }

        // Right — weather + seed
        const wx = W - 22 * S;
        ctx.textAlign = 'right';
        const ws = sim.weather.state;
        ctx.fillStyle = ws.wetness > 0.2 ? '#7ec8ff' : '#ffd97a';
        ctx.font = `bold ${15 * S}px ${FONT}`;
        ctx.fillText(`${ws.icon}  ${ws.label}`, wx, 24 * S);
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.font = `${11 * S}px ${FONT}`;
        ctx.fillText(`SEED ${Rng.toCode(sim.state.seed)}`, wx, 44 * S);

        ctx.restore();
    }

    // -------------------------------------------------------------------------
    // Camera focus label
    // -------------------------------------------------------------------------

    function drawShotLabel(ctx, sim) {
        const subs = Camera.getSubjects();
        if (!subs.length || Camera.getZoom() < 1.15) return;

        let label;
        if (subs.length === 1) label = `LEADER  ·  ${subs[0].name}`;
        else {
            const p = Math.min(...subs.map(c => c.position));
            label = `BATTLE FOR P${p}`;
        }

        ctx.save();
        ctx.textBaseline = 'middle';
        ctx.font = `bold ${12 * S}px ${FONT}`;
        const tw = ctx.measureText(label).width;
        const x = W / 2 - (tw + 34 * S) / 2;
        const y = 74 * S;
        rrect(ctx, x, y, tw + 34 * S, 24 * S, 12 * S);
        ctx.fillStyle = 'rgba(233,69,96,0.85)';
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'left';
        ctx.fillText(label, x + 17 * S, y + 12 * S);
        ctx.restore();
    }

    // -------------------------------------------------------------------------
    // Subtitles & ticker
    // -------------------------------------------------------------------------

    function drawSubtitle(ctx) {
        const cur = Commentary.getCurrent();
        if (!cur) return;

        const now = performance.now();
        const age = now - cur.startedAt;
        const fade = Math.min(1, age / 160) * Math.min(1, (cur.until - now) / 220);
        if (fade <= 0) return;

        ctx.save();
        ctx.globalAlpha = Math.max(0, Math.min(1, fade));
        ctx.font = `${19 * S}px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        const maxW = W * 0.62;
        const lines = _wrap(ctx, cur.text, maxW);
        const lh = 26 * S;
        const boxH = lines.length * lh + 22 * S;
        const boxW = Math.min(maxW + 44 * S, W * 0.72);
        const bx = W / 2 - boxW / 2;
        const by = H - boxH - 92 * S;

        rrect(ctx, bx, by, boxW, boxH, 8);
        ctx.fillStyle = 'rgba(6,8,18,0.82)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.10)';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Little "on air" dot
        ctx.beginPath();
        ctx.arc(bx + 16 * S, by + 14 * S, 4 * S, 0, Math.PI * 2);
        ctx.fillStyle = '#ff4b4b';
        ctx.fill();

        ctx.fillStyle = '#fff';
        lines.forEach((ln, i) => {
            ctx.fillText(ln, W / 2, by + 16 * S + lh * (i + 0.5));
        });
        ctx.restore();
    }

    function _wrap(ctx, text, maxW) {
        const words = text.split(' ');
        const lines = [];
        let line = '';
        for (const w of words) {
            const test = line ? line + ' ' + w : w;
            if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = w; }
            else line = test;
        }
        if (line) lines.push(line);
        return lines.slice(0, 3);
    }

    function drawTicker(ctx) {
        const now = performance.now();
        ctx.save();
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.font = `${12 * S}px ${FONT}`;
        let y = H - 34 * S;
        for (let i = 0; i < flash.length; i++) {
            const f = flash[i];
            const age = (now - f.born) / 1000;
            if (age > 9) continue;
            const alpha = Math.min(1, (9 - age) / 2) * (1 - i * 0.12);
            ctx.globalAlpha = Math.max(0, alpha);
            ctx.fillStyle = f.color;
            ctx.fillRect(22 * S, y - 6 * S, 3 * S, 12 * S);
            ctx.fillStyle = 'rgba(255,255,255,0.85)';
            ctx.fillText(f.text, 31 * S, y);
            y -= 19 * S;
        }
        ctx.restore();
    }

    function drawCaption(ctx) {
        if (!caption) return;
        const now = performance.now();
        if (now > caption.until) { caption = null; return; }
        const age = now - caption.born;
        const life = caption.until - caption.born;
        const inT = Math.min(1, age / 180);
        const outT = Math.min(1, (caption.until - now) / 260);

        ctx.save();
        ctx.globalAlpha = inT * outT;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const scale = 0.86 + 0.14 * inT;
        ctx.translate(W / 2, H * 0.30);
        ctx.scale(scale, scale);
        ctx.font = `bold ${44 * S}px ${FONT}`;
        ctx.shadowColor = caption.color;
        ctx.shadowBlur = 26;
        ctx.fillStyle = caption.color;
        ctx.fillText(caption.text, 0, 0);
        ctx.restore();
    }

    // -------------------------------------------------------------------------
    // Cut flash — a subtle white wipe when the director changes shot
    // -------------------------------------------------------------------------

    function drawCutFlash(ctx) {
        const f = Camera.getCutFlash();
        if (f <= 0.01) return;
        ctx.save();
        ctx.globalAlpha = f * 0.13;
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
    }

    // -------------------------------------------------------------------------

    function draw(ctx, sim, meta) {
        drawCutFlash(ctx);
        drawTopBar(ctx, sim, meta);
        drawTower(ctx, sim);
        drawShotLabel(ctx, sim);
        drawMinimap(ctx, sim);
        drawTicker(ctx);
        drawSubtitle(ctx);
        drawCaption(ctx);
    }

    function reset() {
        caption = null;
        flash.length = 0;
        minimap = null;
    }

    return { resize, draw, onEvent, showCaption, pushFlash, reset, buildMinimap, rrect, fmtTime, fmtClock, get scale() { return S; } };
})();
