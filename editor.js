/**
 * Track editor overlay — slides in from top-left when the mouse is near the corner.
 * Buttons: pause/resume, restart race, show ctrl points, drag ctrl points, new track.
 */
const Editor = (() => {
    let _mx = 0, _my = 0;
    let _slide = 0;           // 0 = hidden, 1 = visible (animated)
    let _pinned = false;      // true once panel has fully slid in; hides only on header click
    let _showCtrl = false;
    let _editMode = false;
    let _dragIdx  = -1;
    let _paused   = false;
    let _canvas   = null;

    // Callbacks injected from main.js
    let _cbRebuildTrack = null;
    let _cbRestartRace  = null;
    let _cbNewTrack     = null;

    // Panel geometry
    const PW       = 210;
    const PAD      = 9;
    const HDR_H    = 38;
    const BTN_H    = 36;
    const BTN_GAP  = 5;
    const CORNER_R = 110;   // mouse proximity radius to reveal panel

    const BTNS = [
        { id: 'pause'    },
        { id: 'restart'  },
        { id: 'showCtrl' },
        { id: 'editCtrl' },
        { id: 'newTrack' },
    ];

    function _label(id) {
        if (id === 'pause')    return _paused ? '▶  RESUME RACE'      : '⏸  PAUSE RACE';
        if (id === 'restart')  return '↺  RESTART RACE';
        if (id === 'showCtrl') return _showCtrl ? '✓  HIDE CTRL PTS'  : '○  SHOW CTRL PTS';
        if (id === 'editCtrl') return _editMode ? '✓  STOP DRAGGING'  : '✥  DRAG CTRL PTS';
        if (id === 'newTrack') return '⊞  NEW TRACK';
        return id;
    }

    function _panelH() {
        return HDR_H + BTNS.length * (BTN_H + BTN_GAP) + PAD;
    }

    // Panel left edge position (slides in from off-screen-left)
    function _px() { return Math.round(-PW + _slide * (PW + 14)); }

    function _btnRect(i) {
        return {
            x: _px() + PAD,
            y: 14 + HDR_H + i * (BTN_H + BTN_GAP),
            w: PW - PAD * 2,
            h: BTN_H,
        };
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

    // ── canvas coords from mouse event ─────────────────────────────────────
    function _canvasXY(e) {
        const r  = _canvas.getBoundingClientRect();
        const sx = _canvas.width  / r.width;
        const sy = _canvas.height / r.height;
        return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy };
    }

    // ── initialise ─────────────────────────────────────────────────────────
    function init(canvas, callbacks) {
        _canvas          = canvas;
        _cbRebuildTrack  = callbacks.onRebuildTrack;
        _cbRestartRace   = callbacks.onRestartRace;
        _cbNewTrack      = callbacks.onNewTrack;

        canvas.addEventListener('mousemove', e => {
            const { x, y } = _canvasXY(e);
            _mx = x; _my = y;

            if (_dragIdx >= 0) {
                Track.setCtrlPoint(_dragIdx, x, y);
                Track.rebuildFromCtrl();
                if (_cbRebuildTrack) _cbRebuildTrack();
            }
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
        canvas.addEventListener('mouseleave', () => { _dragIdx = -1; });

        canvas.addEventListener('click', e => {
            if (_slide < 0.4) return;
            const { x, y } = _canvasXY(e);
            // Click on header → dismiss (unpin) the panel
            const hdrRect = { x: _px(), y: 14, w: PW, h: HDR_H };
            if (_inRect(x, y, hdrRect)) {
                _pinned = false;
                return;
            }
            for (let i = 0; i < BTNS.length; i++) {
                if (_inRect(x, y, _btnRect(i))) {
                    _handleClick(BTNS[i].id);
                    return;
                }
            }
        });
    }

    function _handleClick(id) {
        if (id === 'pause') {
            _paused = !_paused;
        } else if (id === 'restart') {
            _paused = false;
            if (_cbRestartRace) _cbRestartRace();
        } else if (id === 'showCtrl') {
            _showCtrl = !_showCtrl;
        } else if (id === 'editCtrl') {
            _editMode = !_editMode;
            if (_editMode) _showCtrl = true;  // auto-show ctrl pts in edit mode
            if (!_editMode) _dragIdx = -1;
        } else if (id === 'newTrack') {
            _paused = false;
            if (_cbNewTrack) _cbNewTrack();
        }
    }

    // ── update (call each frame with dt) ───────────────────────────────────
    function update(dt) {
        const d2 = _mx * _mx + _my * _my;
        // Latch: once fully open, stay open until header-click dismisses
        if (!_pinned && _slide > 0.98) _pinned = true;
        const target = (_pinned || d2 < CORNER_R * CORNER_R) ? 1 : 0;
        _slide += (target - _slide) * Math.min(1, dt / 120);
        _slide  = Math.max(0, Math.min(1, _slide));
    }

    // ── draw (call each frame after track, before race) ────────────────────
    function draw(ctx) {
        // Control-point overlay (always drawn when enabled, regardless of panel)
        if (_showCtrl || _editMode) {
            Track.drawDebug(ctx, _editMode);
        }

        // Tiny corner indicator so the user knows the panel is there
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

        const px = _px();
        const py = 14;
        const ph = _panelH();
        const alpha = Math.min(1, _slide * 1.8);

        ctx.save();
        ctx.globalAlpha = alpha;

        // Panel background + shadow
        ctx.shadowColor = 'rgba(0,0,0,0.55)';
        ctx.shadowBlur  = 18;
        _rrect(ctx, px, py, PW, ph, 10);
        ctx.fillStyle = 'rgba(10,12,18,0.92)';
        ctx.fill();
        ctx.shadowBlur = 0;

        // Header text + close hint (clicking header dismisses panel)
        const hdrHov = _inRect(_mx, _my, { x: px, y: py, w: PW, h: HDR_H });
        ctx.fillStyle = hdrHov ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.42)';
        ctx.font = 'bold 10px monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText('⚙  TRACK EDITOR', px + 13, py + HDR_H / 2);
        // "×" dismiss hint on the right
        ctx.textAlign = 'right';
        ctx.fillStyle = hdrHov ? 'rgba(255,255,255,0.70)' : 'rgba(255,255,255,0.22)';
        ctx.fillText('×', px + PW - 12, py + HDR_H / 2);

        // Header separator
        ctx.strokeStyle = 'rgba(255,255,255,0.10)';
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(px + 8, py + HDR_H);
        ctx.lineTo(px + PW - 8, py + HDR_H);
        ctx.stroke();

        // Buttons
        for (let i = 0; i < BTNS.length; i++) {
            const id = BTNS[i].id;
            const r  = _btnRect(i);
            const hov    = _inRect(_mx, _my, r);
            const active = (id === 'pause'    && _paused)
                        || (id === 'showCtrl' && _showCtrl)
                        || (id === 'editCtrl' && _editMode);

            // Button fill
            _rrect(ctx, r.x, r.y, r.w, r.h, 6);
            ctx.fillStyle = active  ? 'rgba(80,210,130,0.22)'
                          : hov     ? 'rgba(255,255,255,0.11)'
                          :           'rgba(255,255,255,0.04)';
            ctx.fill();

            // Active border
            if (active) {
                _rrect(ctx, r.x, r.y, r.w, r.h, 6);
                ctx.strokeStyle = 'rgba(80,210,130,0.50)';
                ctx.lineWidth = 1;
                ctx.stroke();
            }

            // Label
            ctx.fillStyle = active ? '#90EE90' : 'rgba(255,255,255,0.84)';
            ctx.font = '12px monospace';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(_label(id), r.x + 11, r.y + r.h / 2);
        }

        // Edit-mode hint
        if (_editMode) {
            ctx.fillStyle = 'rgba(255,220,60,0.65)';
            ctx.font = '10px monospace';
            ctx.textAlign = 'center';
            ctx.fillText('drag the yellow circles', px + PW / 2, py + ph - 8);
        }

        ctx.restore();
    }

    function isPaused() { return _paused; }

    return { init, update, draw, isPaused };
})();
