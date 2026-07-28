/**
 * Track editor overlay — slides in from the top-left when the mouse is near
 * the corner. Drag the control points to reshape the circuit.
 *
 * Note: the panel is drawn in *screen* space (drawPanel) while the control
 * points live in *world* space (drawWorld), so mouse positions are tracked in
 * both coordinate systems.
 */
const Editor = (() => {
    // Start far off-screen: with the cursor at (0,0) the corner hotspot would
    // trigger before the user has even moved the mouse.
    let _mx = -9999, _my = -9999;   // screen coords (panel hit-testing)
    let _wx = 0, _wy = 0;        // world coords (control points)
    let _slide = 0;
    let _pinned = false;
    let _dismissed = false;
    let _dismissedTimer = 0;
    let _showCtrl = false;
    let _editMode = false;
    let _dragIdx = -1;

    let _ghostSeg = -1;
    let _ghostPt = null;

    let _canvas = null;
    let _cbRebuildTrack = null;
    let _cbRestartRace = null;
    let _cbNewTrack = null;

    const PW = 210, PAD = 9, HDR_H = 38, BTN_H = 36, BTN_GAP = 5;
    const CORNER_R = 110;
    const GHOST_R = 40;

    const BTNS = [
        { id: 'restart' },
        { id: 'showCtrl' },
        { id: 'editCtrl' },
        { id: 'newTrack' },
    ];

    function _label(id) {
        if (id === 'restart')  return '↺  RESTART RACE';
        if (id === 'showCtrl') return _showCtrl ? '✓  HIDE CTRL PTS' : '○  SHOW CTRL PTS';
        if (id === 'editCtrl') return _editMode ? '✓  STOP EDITING' : '✥  DRAG CTRL PTS';
        if (id === 'newTrack') return '⊞  NEW TRACK';
        return id;
    }

    function _panelH() { return HDR_H + BTNS.length * (BTN_H + BTN_GAP) + PAD; }
    function _px()     { return Math.round(-PW + _slide * (PW + 14)); }

    function _btnRect(i) {
        return { x: _px() + PAD, y: 14 + HDR_H + i * (BTN_H + BTN_GAP), w: PW - PAD * 2, h: BTN_H };
    }

    function _inRect(mx, my, r) {
        return mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h;
    }

    function _rrect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
        ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
        ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
        ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
        ctx.closePath();
    }

    function _screenXY(e) {
        const r = _canvas.getBoundingClientRect();
        return {
            x: (e.clientX - r.left) * (_canvas.width / r.width),
            y: (e.clientY - r.top) * (_canvas.height / r.height),
        };
    }

    // ── ghost insertion ──────────────────────────────────────────────────────
    function _updateGhost(wx, wy) {
        if (!_editMode || _dragIdx >= 0) { _ghostSeg = -1; _ghostPt = null; return; }

        const pts = Track.getCtrlPoints();
        const n = pts.length;
        for (let i = 0; i < n; i++) {
            const dx = pts[i].x - wx, dy = pts[i].y - wy;
            if (dx * dx + dy * dy < 22 * 22) { _ghostSeg = -1; _ghostPt = null; return; }
        }

        let bestD2 = GHOST_R * GHOST_R, bestSeg = -1, bestPt = null;
        for (let i = 0; i < n; i++) {
            const a = pts[i], b = pts[(i + 1) % n];
            const mx2 = (a.x + b.x) / 2, my2 = (a.y + b.y) / 2;
            const dx = wx - mx2, dy = wy - my2;
            const d2 = dx * dx + dy * dy;
            if (d2 < bestD2) { bestD2 = d2; bestSeg = i; bestPt = { x: mx2, y: my2 }; }
        }
        _ghostSeg = bestSeg;
        _ghostPt = bestPt;
    }

    function _insertCtrlPoint(seg) {
        const pts = Track.getCtrlPoints();
        const a = pts[seg], b = pts[(seg + 1) % pts.length];
        pts.splice(seg + 1, 0, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
        Track.rebuildFromCtrl();
        if (_cbRebuildTrack) _cbRebuildTrack();
        _ghostSeg = -1;
        _ghostPt = null;
    }

    // ── init ─────────────────────────────────────────────────────────────────
    function init(canvas, callbacks) {
        _canvas = canvas;
        _cbRebuildTrack = callbacks.onRebuildTrack;
        _cbRestartRace = callbacks.onRestartRace;
        _cbNewTrack = callbacks.onNewTrack;

        canvas.addEventListener('mousemove', e => {
            const s = _screenXY(e);
            _mx = s.x; _my = s.y;
            const w = Camera.screenToWorld(s.x, s.y);
            _wx = w.x; _wy = w.y;

            if (_dragIdx >= 0) {
                Track.setCtrlPoint(_dragIdx, _wx, _wy);
                Track.rebuildFromCtrl();
                if (_cbRebuildTrack) _cbRebuildTrack();
            }
            _updateGhost(_wx, _wy);
        });

        canvas.addEventListener('mousedown', e => {
            if (!_editMode) return;
            const s = _screenXY(e);
            const w = Camera.screenToWorld(s.x, s.y);
            const pts = Track.getCtrlPoints();
            for (let i = 0; i < pts.length; i++) {
                const dx = pts[i].x - w.x, dy = pts[i].y - w.y;
                if (dx * dx + dy * dy < 18 * 18) { _dragIdx = i; e.preventDefault(); return; }
            }
        });

        canvas.addEventListener('mouseup', () => { _dragIdx = -1; });
        canvas.addEventListener('mouseleave', () => { _dragIdx = -1; _ghostSeg = -1; _ghostPt = null; });

        canvas.addEventListener('click', e => {
            const s = _screenXY(e);

            if (_slide > 0.4) {
                const hdrRect = { x: _px(), y: 14, w: PW, h: HDR_H };
                if (_inRect(s.x, s.y, hdrRect)) {
                    _pinned = false;
                    _dismissed = true;
                    _dismissedTimer = 2000;
                    return;
                }
                for (let i = 0; i < BTNS.length; i++) {
                    if (_inRect(s.x, s.y, _btnRect(i))) { _handleClick(BTNS[i].id); return; }
                }
            }

            if (_editMode && _ghostSeg >= 0) _insertCtrlPoint(_ghostSeg);
        });
    }

    function _handleClick(id) {
        if (id === 'restart')       { if (_cbRestartRace) _cbRestartRace(); }
        else if (id === 'showCtrl') { _showCtrl = !_showCtrl; }
        else if (id === 'editCtrl') {
            _editMode = !_editMode;
            if (_editMode) _showCtrl = true;
            else { _dragIdx = -1; _ghostSeg = -1; _ghostPt = null; }
        }
        else if (id === 'newTrack') { if (_cbNewTrack) _cbNewTrack(); }
    }

    // ── update ───────────────────────────────────────────────────────────────
    function update(dt) {
        const d2 = _mx * _mx + _my * _my;
        const inCorner = d2 < CORNER_R * CORNER_R;
        if (_dismissed) {
            _dismissedTimer -= dt;
            if (_dismissedTimer <= 0) { _dismissed = false; _dismissedTimer = 0; }
        }
        if (!_pinned && _slide > 0.98) _pinned = true;
        const target = !_dismissed && (_pinned || inCorner) ? 1 : 0;
        _slide += (target - _slide) * Math.min(1, dt / 120);
        _slide = Math.max(0, Math.min(1, _slide));
    }

    // ── draw: world space ────────────────────────────────────────────────────
    function drawWorld(ctx) {
        if (_showCtrl || _editMode) Track.drawDebug(ctx, _editMode);

        if (_editMode && _ghostSeg >= 0 && _ghostPt) {
            const gx = _ghostPt.x, gy = _ghostPt.y;
            ctx.save();
            ctx.globalAlpha = 0.55;
            ctx.beginPath();
            ctx.arc(gx, gy, 14, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(255, 200, 0, 0.45)';
            ctx.fill();
            ctx.strokeStyle = 'rgba(255,255,255,0.8)';
            ctx.lineWidth = 2;
            ctx.setLineDash([]);
            ctx.stroke();
            ctx.fillStyle = '#000';
            ctx.font = 'bold 16px monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('+', gx, gy);
            ctx.restore();
        }
    }

    // ── draw: screen space ───────────────────────────────────────────────────
    function drawPanel(ctx) {
        if (_slide < 0.25) {
            ctx.save();
            ctx.globalAlpha = (1 - _slide / 0.25) * 0.25;
            ctx.fillStyle = '#fff';
            ctx.beginPath();
            ctx.moveTo(0, 0); ctx.lineTo(22, 0); ctx.lineTo(0, 22);
            ctx.closePath(); ctx.fill();
            ctx.restore();
        }

        if (_slide < 0.02) return;

        const px = _px(), py = 14, ph = _panelH();
        const alpha = Math.min(1, _slide * 1.8);

        ctx.save();
        ctx.globalAlpha = alpha;

        ctx.shadowColor = 'rgba(0,0,0,0.55)';
        ctx.shadowBlur = 18;
        _rrect(ctx, px, py, PW, ph, 10);
        ctx.fillStyle = 'rgba(10,12,18,0.92)';
        ctx.fill();
        ctx.shadowBlur = 0;

        const hdrHov = _inRect(_mx, _my, { x: px, y: py, w: PW, h: HDR_H });
        ctx.fillStyle = hdrHov ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.42)';
        ctx.font = 'bold 10px monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText('⚙  TRACK EDITOR', px + 13, py + HDR_H / 2);
        ctx.textAlign = 'right';
        ctx.fillStyle = hdrHov ? 'rgba(255,255,255,0.70)' : 'rgba(255,255,255,0.22)';
        ctx.fillText('×', px + PW - 12, py + HDR_H / 2);

        ctx.strokeStyle = 'rgba(255,255,255,0.10)';
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(px + 8, py + HDR_H); ctx.lineTo(px + PW - 8, py + HDR_H);
        ctx.stroke();

        for (let i = 0; i < BTNS.length; i++) {
            const id = BTNS[i].id;
            const r = _btnRect(i);
            const hov = _inRect(_mx, _my, r);
            const active = (id === 'showCtrl' && _showCtrl) || (id === 'editCtrl' && _editMode);

            _rrect(ctx, r.x, r.y, r.w, r.h, 6);
            ctx.fillStyle = active ? 'rgba(80,210,130,0.22)' : hov ? 'rgba(255,255,255,0.11)' : 'rgba(255,255,255,0.04)';
            ctx.fill();

            if (active) {
                _rrect(ctx, r.x, r.y, r.w, r.h, 6);
                ctx.strokeStyle = 'rgba(80,210,130,0.50)';
                ctx.lineWidth = 1;
                ctx.stroke();
            }

            ctx.fillStyle = active ? '#90EE90' : 'rgba(255,255,255,0.84)';
            ctx.font = '12px monospace';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(_label(id), r.x + 11, r.y + r.h / 2);
        }

        if (_editMode) {
            ctx.fillStyle = 'rgba(255,220,60,0.65)';
            ctx.font = '10px monospace';
            ctx.textAlign = 'center';
            ctx.fillText('drag to move  ·  click edge to add', px + PW / 2, py + ph - 8);
        }

        ctx.restore();
    }

    return { init, update, drawWorld, drawPanel };
})();
