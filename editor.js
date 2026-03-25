/**
 * Track editor overlay — slides in from top-left when the mouse is near the corner.
 * Spacebar toggles pause. Race starts paused so user can review the track first.
 */
const Editor = (() => {
    let _mx = 0, _my = 0;
    let _slide   = 0;      // 0 = hidden, 1 = visible (animated)
    let _pinned  = false;  // latches true once fully open; header-click to dismiss
    let _dismissed = false;  // true after header-click; prevents re-open until mouse leaves corner
    let _showCtrl = false;
    let _editMode = false;
    let _dragIdx  = -1;
    let _paused   = true;  // start paused — press Space or ▶ to begin

    // Ghost insertion point (edit mode: hover midpoint between two ctrl pts)
    let _ghostSeg = -1;    // index of the segment whose midpoint is hovered (-1 = none)
    let _ghostPt  = null;  // {x, y} of that midpoint

    let _canvas          = null;
    let _cbRebuildTrack  = null;
    let _cbRestartRace   = null;
    let _cbNewTrack      = null;

    // Panel geometry
    const PW       = 210;
    const PAD      = 9;
    const HDR_H    = 38;
    const BTN_H    = 36;
    const BTN_GAP  = 5;
    const CORNER_R = 110;      // mouse proximity to reveal panel
    const GHOST_R  = 40;       // mouse proximity to midpoint to show ghost

    const BTNS = [
        { id: 'pause'    },
        { id: 'restart'  },
        { id: 'showCtrl' },
        { id: 'editCtrl' },
        { id: 'newTrack' },
    ];

    function _label(id) {
        if (id === 'pause')    return _paused ? '▶  RESUME RACE'     : '⏸  PAUSE RACE';
        if (id === 'restart')  return '↺  RESTART RACE';
        if (id === 'showCtrl') return _showCtrl ? '✓  HIDE CTRL PTS' : '○  SHOW CTRL PTS';
        if (id === 'editCtrl') return _editMode ? '✓  STOP EDITING'  : '✥  DRAG CTRL PTS';
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
        ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y,     x + w, y + r,     r);
        ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
        ctx.lineTo(x + r, y + h); ctx.arcTo(x,     y + h, x,     y + h - r, r);
        ctx.lineTo(x, y + r); ctx.arcTo(x,     y,     x + r,   y,         r);
        ctx.closePath();
    }

    function _canvasXY(e) {
        const r = _canvas.getBoundingClientRect();
        return {
            x: (e.clientX - r.left) * (_canvas.width  / r.width),
            y: (e.clientY - r.top)  * (_canvas.height / r.height),
        };
    }

    // ── ghost insertion helpers ─────────────────────────────────────────────
    function _updateGhost(mx, my) {
        if (!_editMode || _dragIdx >= 0) { _ghostSeg = -1; _ghostPt = null; return; }

        const pts = Track.getCtrlPoints();
        const n   = pts.length;

        // Don't show ghost when mouse is near an existing ctrl point
        for (let i = 0; i < n; i++) {
            const dx = pts[i].x - mx, dy = pts[i].y - my;
            if (dx * dx + dy * dy < 22 * 22) { _ghostSeg = -1; _ghostPt = null; return; }
        }

        // Find nearest segment midpoint within GHOST_R
        let bestD2 = GHOST_R * GHOST_R, bestSeg = -1, bestPt = null;
        for (let i = 0; i < n; i++) {
            const a = pts[i], b = pts[(i + 1) % n];
            const mx2 = (a.x + b.x) / 2, my2 = (a.y + b.y) / 2;
            const dx = mx - mx2, dy = my - my2;
            const d2 = dx * dx + dy * dy;
            if (d2 < bestD2) { bestD2 = d2; bestSeg = i; bestPt = { x: mx2, y: my2 }; }
        }
        _ghostSeg = bestSeg;
        _ghostPt  = bestPt;
    }

    function _insertCtrlPoint(seg) {
        const pts = Track.getCtrlPoints();
        const a   = pts[seg], b = pts[(seg + 1) % pts.length];
        pts.splice(seg + 1, 0, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
        Track.rebuildFromCtrl();
        if (_cbRebuildTrack) _cbRebuildTrack();
        _ghostSeg = -1;
        _ghostPt  = null;
    }

    // ── init ───────────────────────────────────────────────────────────────
    function init(canvas, callbacks) {
        _canvas         = canvas;
        _cbRebuildTrack = callbacks.onRebuildTrack;
        _cbRestartRace  = callbacks.onRestartRace;
        _cbNewTrack     = callbacks.onNewTrack;

        canvas.addEventListener('mousemove', e => {
            const { x, y } = _canvasXY(e);
            _mx = x; _my = y;

            if (_dragIdx >= 0) {
                Track.setCtrlPoint(_dragIdx, x, y);
                Track.rebuildFromCtrl();
                if (_cbRebuildTrack) _cbRebuildTrack();
            }
            _updateGhost(x, y);
        });

        canvas.addEventListener('mousedown', e => {
            if (!_editMode) return;
            const { x, y } = _canvasXY(e);
            const pts = Track.getCtrlPoints();
            for (let i = 0; i < pts.length; i++) {
                const dx = pts[i].x - x, dy = pts[i].y - y;
                if (dx * dx + dy * dy < 18 * 18) {
                    _dragIdx = i;
                    e.preventDefault();
                    return;
                }
            }
        });

        canvas.addEventListener('mouseup',    () => { _dragIdx = -1; });
        canvas.addEventListener('mouseleave', () => { _dragIdx = -1; _ghostSeg = -1; _ghostPt = null; });

        canvas.addEventListener('click', e => {
            const { x, y } = _canvasXY(e);

            // Panel interactions (when visible)
            if (_slide > 0.4) {
                const hdrRect = { x: _px(), y: 14, w: PW, h: HDR_H };
                if (_inRect(x, y, hdrRect)) {
                _pinned = false;
                _dismissed = true;  // prevent immediate re-open while mouse is still in corner
                return;
            }
                for (let i = 0; i < BTNS.length; i++) {
                    if (_inRect(x, y, _btnRect(i))) { _handleClick(BTNS[i].id); return; }
                }
            }

            // Ghost-point insertion (edit mode, click on highlighted midpoint)
            if (_editMode && _ghostSeg >= 0) {
                _insertCtrlPoint(_ghostSeg);
            }
        });

        // Spacebar toggles pause
        window.addEventListener('keydown', e => {
            if (e.code === 'Space' && e.target === document.body) {
                e.preventDefault();
                _paused = !_paused;
            }
        });
    }

    function _handleClick(id) {
        if (id === 'pause') {
            _paused = !_paused;
        } else if (id === 'restart') {
            _paused = true;   // restart begins paused
            if (_cbRestartRace) _cbRestartRace();
        } else if (id === 'showCtrl') {
            _showCtrl = !_showCtrl;
        } else if (id === 'editCtrl') {
            _editMode = !_editMode;
            if (_editMode)  _showCtrl = true;
            if (!_editMode) { _dragIdx = -1; _ghostSeg = -1; _ghostPt = null; }
        } else if (id === 'newTrack') {
            _paused = true;   // new track begins paused
            if (_cbNewTrack) _cbNewTrack();
        }
    }

    // ── update ─────────────────────────────────────────────────────────────
    function update(dt) {
        const d2 = _mx * _mx + _my * _my;
        const inCorner = d2 < CORNER_R * CORNER_R;
        // Reset dismissed once mouse fully leaves the trigger area
        if (_dismissed && !inCorner) _dismissed = false;
        if (!_pinned && _slide > 0.98) _pinned = true;
        const target = !_dismissed && (_pinned || inCorner) ? 1 : 0;
        _slide += (target - _slide) * Math.min(1, dt / 120);
        _slide  = Math.max(0, Math.min(1, _slide));
    }

    // ── draw ───────────────────────────────────────────────────────────────
    function draw(ctx) {
        // Ctrl-point overlay
        if (_showCtrl || _editMode) Track.drawDebug(ctx, _editMode);

        // Ghost insertion indicator
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

        // Tiny corner triangle hint when panel is hidden
        if (_slide < 0.25) {
            ctx.save();
            ctx.globalAlpha = (1 - _slide / 0.25) * 0.35;
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

        // Panel background
        ctx.shadowColor = 'rgba(0,0,0,0.55)';
        ctx.shadowBlur  = 18;
        _rrect(ctx, px, py, PW, ph, 10);
        ctx.fillStyle = 'rgba(10,12,18,0.92)';
        ctx.fill();
        ctx.shadowBlur = 0;

        // Header (hover to highlight, click to dismiss)
        const hdrHov = _inRect(_mx, _my, { x: px, y: py, w: PW, h: HDR_H });
        ctx.fillStyle = hdrHov ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.42)';
        ctx.font = 'bold 10px monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText('⚙  TRACK EDITOR', px + 13, py + HDR_H / 2);
        ctx.textAlign = 'right';
        ctx.fillStyle = hdrHov ? 'rgba(255,255,255,0.70)' : 'rgba(255,255,255,0.22)';
        ctx.fillText('×', px + PW - 12, py + HDR_H / 2);

        // Separator
        ctx.strokeStyle = 'rgba(255,255,255,0.10)';
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(px + 8, py + HDR_H); ctx.lineTo(px + PW - 8, py + HDR_H);
        ctx.stroke();

        // Buttons
        for (let i = 0; i < BTNS.length; i++) {
            const id = BTNS[i].id;
            const r  = _btnRect(i);
            const hov    = _inRect(_mx, _my, r);
            const active = (id === 'pause'    && _paused)
                        || (id === 'showCtrl' && _showCtrl)
                        || (id === 'editCtrl' && _editMode);

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

        // Edit hint
        if (_editMode) {
            ctx.fillStyle = 'rgba(255,220,60,0.65)';
            ctx.font = '10px monospace';
            ctx.textAlign = 'center';
            ctx.fillText('drag to move  ·  click edge to add', px + PW / 2, py + ph - 8);
        }

        ctx.restore();
    }

    function isPaused()       { return _paused; }
    function setPaused(v)     { _paused = v; }

    return { init, update, draw, isPaused, setPaused };
})();
