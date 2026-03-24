/**
 * Race management: qualifying lap → fancy grid reveal → real race.
 *
 * Phase flow:
 *   'qual_countdown'  3-second lights before qualifying lap
 *   'qualifying'      1 ghost lap, no collisions, timed for grid order
 *   'transition'      5-second cinematic result screen + grid set
 *   'race_countdown'  3-second lights before real race
 *   'race'            normal race (TOTAL_LAPS)
 */
const Race = (() => {
    const TEAMS = ['blue', 'yellow', 'red', 'green'];
    const CARS_PER_TEAM = 2;
    const TOTAL_LAPS = 10;
    const TRANSITION_DURATION = 5500; // ms

    const TEAM_NUMBERS = { blue: [1, 2], yellow: [3, 4], red: [5, 6], green: [7, 8] };

    let cars = [];
    let phase = 'qual_countdown';
    let phaseTimer = 0;         // ms elapsed in current phase (or ms remaining for countdowns)
    let qualifyingResults = []; // [{car, lapTime}] sorted fastest-first after qualifying
    let leader = null;
    let finishOrder = [];
    let speedMultiplier = 1;

    // -------------------------------------------------------------------------
    // Init
    // -------------------------------------------------------------------------

    function init() {
        cars = [];
        phase = 'qual_countdown';
        phaseTimer = 3000;
        qualifyingResults = [];
        finishOrder = [];
        leader = null;

        PowerUps.init();

        // All 8 cars start at the exact same spot — ghost lap will spread them out
        for (const team of TEAMS) {
            for (const num of TEAM_NUMBERS[team]) {
                const car = new Car(team, num);
                car.placeOnTrack(1.0, 0);
                car.qualifyingDone = false;
                car.qualifyingTime = null;
                cars.push(car);
            }
        }
    }

    // -------------------------------------------------------------------------
    // Update
    // -------------------------------------------------------------------------

    function update(dt) {
        const adt = dt * speedMultiplier; // adjusted dt (ms)

        if (phase === 'qual_countdown') {
            phaseTimer -= adt;
            if (phaseTimer <= 0) {
                phase = 'qualifying';
                phaseTimer = 0;
            }
            return;
        }

        if (phase === 'qualifying')    { _updateQualifying(adt);    return; }
        if (phase === 'transition')    { _updateTransition(adt);    return; }
        if (phase === 'race_countdown'){ _updateRaceCountdown(adt); return; }
        if (phase === 'race')          { _updateRace(adt);          return; }
    }

    function _updateQualifying(adt) {
        phaseTimer += adt;
        const dtSec = adt / 1000;

        Effects.update(dtSec);

        for (const car of cars) {
            if (!car.qualifyingDone) {
                // noCollisions = true → ghost lap, no pushing
                car.update(dtSec, cars, phaseTimer, phaseTimer, true);
            }
        }

        // Assign live positions so AI and powerups still work
        const active = cars.filter(c => !c.qualifyingDone);
        active.sort((a, b) => b.totalProgress - a.totalProgress);
        for (let i = 0; i < active.length; i++) active[i].position = i + 1;
        leader = active[0] || cars[0];

        PowerUps.update(dtSec, cars, leader);

        // Detect qualifying lap completions
        for (const car of cars) {
            if (!car.qualifyingDone && car.lap >= 1) {
                car.qualifyingDone = true;
                car.qualifyingTime = car.lastLapTime;
                qualifyingResults.push({ car, lapTime: car.lastLapTime });
            }
        }

        // All done or 90-second safety timeout
        if (cars.every(c => c.qualifyingDone) || phaseTimer > 90000) {
            _finaliseQualifying();
        }
    }

    function _finaliseQualifying() {
        // Sort fastest → slowest. DNF cars go to the back.
        qualifyingResults.sort((a, b) => (a.lapTime || Infinity) - (b.lapTime || Infinity));
        const doneSet = new Set(qualifyingResults.map(r => r.car));
        for (const car of cars) {
            if (!doneSet.has(car)) qualifyingResults.push({ car, lapTime: null });
        }
        // Assign qualifying positions (P1 = pole)
        for (let i = 0; i < qualifyingResults.length; i++) {
            qualifyingResults[i].car.position = i + 1;
        }
        phase = 'transition';
        phaseTimer = 0;
    }

    function _updateTransition(adt) {
        phaseTimer += adt;
        if (phaseTimer >= TRANSITION_DURATION) {
            _setupGrid();
            phase = 'race_countdown';
            phaseTimer = 3000;
        }
    }

    function _setupGrid() {
        // Place cars in qualifying order on the staggered starting grid
        for (let i = 0; i < qualifyingResults.length; i++) {
            const car = qualifyingResults[i].car;
            const side = i % 2 === 0 ? -1 : 1;
            car.placeOnTrack(1 - i * 0.012, side * 16);
        }
        PowerUps.init();
        finishOrder = [];
        leader = null;
    }

    function _updateRaceCountdown(adt) {
        phaseTimer -= adt;
        if (phaseTimer <= 0) {
            phase = 'race';
            phaseTimer = 0;
        }
    }

    function _updateRace(adt) {
        phaseTimer += adt;
        const dtSec = adt / 1000;
        const timeSinceStart = phaseTimer;

        Effects.update(dtSec);

        for (const car of cars) {
            car.update(dtSec, cars, phaseTimer, timeSinceStart, false);
        }

        const sorted = [...cars].sort((a, b) => b.totalProgress - a.totalProgress);
        for (let i = 0; i < sorted.length; i++) sorted[i].position = i + 1;
        leader = sorted[0];

        PowerUps.update(dtSec, cars, leader);

        for (const car of cars) {
            if (car.lap >= TOTAL_LAPS && !finishOrder.includes(car)) {
                finishOrder.push(car);
            }
        }
    }

    // -------------------------------------------------------------------------
    // Draw
    // -------------------------------------------------------------------------

    function draw(ctx) {
        Effects.draw(ctx);
        PowerUps.draw(ctx);

        // Cars sorted by progress for painter's algorithm (back car first)
        const sorted = [...cars].sort((a, b) => a.totalProgress - b.totalProgress);
        for (const car of sorted) car.draw(ctx);

        _drawPhaseOverlay(ctx);
    }

    function _drawPhaseOverlay(ctx) {
        const W = ctx.canvas.width, H = ctx.canvas.height;
        const cx = W / 2, cy = H / 2;

        if (phase === 'qual_countdown') {
            _drawCountdown(ctx, W, H, cx, cy, phaseTimer, 'QUALIFYING LAP', '#00ccff');
        } else if (phase === 'transition') {
            _drawTransition(ctx, W, H, cx, cy);
        } else if (phase === 'race_countdown') {
            _drawCountdown(ctx, W, H, cx, cy, phaseTimer, 'RACE START', '#ff4444');
        } else if (phase === 'race' && finishOrder.length === cars.length) {
            _drawFinished(ctx, W, H, cx);
        }
    }

    function _drawCountdown(ctx, W, H, cx, cy, msRemaining, label, accentColor) {
        ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,0.38)';
        ctx.fillRect(0, 0, W, H);

        // Label
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = accentColor;
        ctx.font = 'bold 18px Arial';
        ctx.globalAlpha = 0.9;
        ctx.fillText(label, cx, cy - 55);

        // Lights
        const total = 3;
        const lightsOn = total - Math.max(0, Math.ceil(msRemaining / 1000));
        for (let i = 0; i < total; i++) {
            const lx = cx - 60 + i * 60;
            const lit = i < lightsOn;
            ctx.globalAlpha = 1;
            ctx.beginPath();
            ctx.arc(lx, cy - 15, 18, 0, Math.PI * 2);
            ctx.fillStyle = lit ? accentColor : accentColor.replace(')', ', 0.15)').replace('rgb', 'rgba');
            ctx.fill();
            ctx.strokeStyle = '#666';
            ctx.lineWidth = 2;
            ctx.stroke();
            if (lit) {
                ctx.globalAlpha = 0.4;
                ctx.beginPath();
                ctx.arc(lx, cy - 15, 28, 0, Math.PI * 2);
                ctx.fillStyle = accentColor;
                ctx.fill();
                ctx.globalAlpha = 1;
            }
        }

        const countdown = Math.ceil(msRemaining / 1000);
        ctx.globalAlpha = 1;
        ctx.fillStyle = countdown > 0 ? '#fff' : '#00ff88';
        ctx.font = 'bold 52px Arial';
        ctx.fillText(countdown > 0 ? countdown : 'GO!', cx, cy + 45);
        ctx.restore();
    }

    function _drawTransition(ctx, W, H, cx, cy) {
        const t = phaseTimer / TRANSITION_DURATION; // 0 → 1
        ctx.save();

        // Animated dark gradient background
        const overlayAlpha = Math.min(1, t * 4) * 0.88;
        ctx.fillStyle = `rgba(5, 5, 20, ${overlayAlpha})`;
        ctx.fillRect(0, 0, W, H);

        // ── HEADER ──
        const headerT = Math.max(0, Math.min(1, (t - 0.0) / 0.15));
        const headerScale = 0.5 + 0.5 * headerT;
        ctx.globalAlpha = headerT;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.save();
        ctx.translate(cx, cy - 160);
        ctx.scale(headerScale, headerScale);
        ctx.shadowColor = '#00ccff';
        ctx.shadowBlur = 30;
        ctx.fillStyle = '#00ccff';
        ctx.font = 'bold 32px Arial';
        ctx.fillText('QUALIFYING COMPLETE', 0, 0);
        ctx.shadowBlur = 0;
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.font = '13px Arial';
        ctx.fillText('GRID POSITIONS LOCKED IN', 0, 32);
        ctx.restore();

        // ── RESULT ROWS ──
        const rowHeight = 36;
        const listTop = cy - 110;
        const rowRevealStart = 0.12;
        const rowRevealStep = 0.09;

        for (let i = 0; i < qualifyingResults.length; i++) {
            const { car, lapTime } = qualifyingResults[i];
            const rowT = Math.max(0, Math.min(1, (t - rowRevealStart - i * rowRevealStep) / 0.12));
            if (rowT <= 0) continue;

            const y = listTop + i * rowHeight;
            const slideX = (1 - rowT) * 250; // slide in from right

            ctx.save();
            ctx.globalAlpha = rowT * 0.95;
            ctx.translate(slideX, 0);

            const colors = CarSVG.TEAM_COLORS[car.team];
            const isFirst = i === 0;

            // Row background
            const rowW = 460, rowH = 30, rowX = cx - rowW / 2;
            ctx.fillStyle = isFirst ? 'rgba(255,215,0,0.12)' : 'rgba(255,255,255,0.05)';
            ctx.beginPath();
            ctx.roundRect(rowX, y - rowH / 2, rowW, rowH, 4);
            ctx.fill();

            // Left accent bar
            ctx.fillStyle = colors.light;
            ctx.fillRect(rowX, y - rowH / 2, 4, rowH);

            // Position badge
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.font = `bold 14px Arial`;
            ctx.fillStyle = isFirst ? '#ffd700' : 'rgba(255,255,255,0.55)';
            ctx.fillText(`P${i + 1}`, rowX + 14, y);

            // Car name
            ctx.fillStyle = colors.light;
            ctx.font = 'bold 14px Arial';
            ctx.fillText(car.name, rowX + 55, y);

            // Lap time
            ctx.textAlign = 'right';
            ctx.fillStyle = isFirst ? '#ffd700' : '#ccc';
            ctx.font = '13px monospace';
            const timeStr = lapTime ? _formatTime(lapTime) : 'DNF';
            ctx.fillText(timeStr, rowX + rowW - 14, y);

            // Gap to P1
            if (i > 0 && lapTime && qualifyingResults[0].lapTime) {
                const gap = lapTime - qualifyingResults[0].lapTime;
                ctx.fillStyle = 'rgba(255,255,255,0.4)';
                ctx.font = '11px monospace';
                ctx.fillText(`+${_formatTime(gap)}`, rowX + rowW - 14, y + 10);
            }

            ctx.restore();
        }

        // ── RACE STARTS IN countdown (last ~2 seconds) ──
        const ctdwnT = Math.max(0, (t - 0.65) / 0.1);
        if (ctdwnT > 0) {
            ctx.globalAlpha = ctdwnT;
            const remaining = Math.max(0, TRANSITION_DURATION - phaseTimer);
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.font = 'bold 22px Arial';
            ctx.fillStyle = '#ff4444';
            ctx.shadowColor = '#ff4444';
            ctx.shadowBlur = 15;
            ctx.fillText(`RACE STARTS IN ${(remaining / 1000).toFixed(1)}s`, cx, cy + 155);
            ctx.shadowBlur = 0;
        }

        ctx.restore();
    }

    function _drawFinished(ctx, W, H, cx) {
        const cy = 50;
        ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,0.75)';
        ctx.fillRect(cx - 160, cy - 28, 320, 56);
        ctx.strokeStyle = '#ffd700';
        ctx.lineWidth = 2;
        ctx.strokeRect(cx - 160, cy - 28, 320, 56);
        ctx.fillStyle = '#ffd700';
        ctx.font = 'bold 26px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const winner = finishOrder[0];
        ctx.fillText(`WINNER: ${winner.name}`, cx, cy);
        ctx.restore();
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    function _formatTime(ms) {
        const m = Math.floor(ms / 60000);
        const s = Math.floor((ms % 60000) / 1000);
        const cs = Math.floor((ms % 1000) / 10);
        return `${m}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
    }

    // -------------------------------------------------------------------------
    // Public API (unchanged signatures)
    // -------------------------------------------------------------------------

    function getStandings() {
        return [...cars].sort((a, b) => a.position - b.position);
    }

    function getTeamScores() {
        const scores = {};
        for (const team of TEAMS) scores[team] = 0;
        const pointsTable = [10, 8, 6, 5, 4, 3, 2, 1];
        const standings = getStandings();
        for (let i = 0; i < standings.length; i++) {
            scores[standings[i].team] += pointsTable[i] || 0;
        }
        return TEAMS.map(t => ({
            team: t, points: scores[t], colors: CarSVG.TEAM_COLORS[t]
        })).sort((a, b) => b.points - a.points);
    }

    function getBestLaps() {
        return [...cars]
            .filter(c => c.bestLapTime < Infinity)
            .sort((a, b) => a.bestLapTime - b.bestLapTime)
            .slice(0, 5);
    }

    function setSpeed(mult)      { speedMultiplier = mult; }
    function getCars()           { return cars; }
    function getLeader()         { return leader; }
    function getRaceTime()       { return phaseTimer; }
    function isStarted()         { return phase === 'race' || phase === 'qualifying'; }
    function isFinished()        { return phase === 'race' && finishOrder.length === cars.length; }
    function getTotalLaps()      { return TOTAL_LAPS; }
    function getSpeedMultiplier(){ return speedMultiplier; }
    function getPhase()          { return phase; }

    return {
        init, update, draw, getStandings, getTeamScores, getBestLaps,
        setSpeed, getCars, getLeader, getRaceTime, isStarted, isFinished,
        getTotalLaps, getSpeedMultiplier, getPhase
    };
})();
