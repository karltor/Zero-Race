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
    const TRANSITION_DURATION = 9500; // ms (5.5s display + 4s extra)

    const TEAM_NUMBERS = { blue: [1, 2], yellow: [3, 4], red: [5, 6], green: [7, 8] };

    let cars = [];
    let phase = 'qual_countdown';
    let phaseTimer = 0;         // ms elapsed in current phase (or ms remaining for countdowns)
    let qualifyingResults = []; // [{car, lapTime}] sorted fastest-first after qualifying
    let leader = null;
    let finishOrder = [];
    let speedMultiplier = 1;
    let _endScreenTimer = -1;  // ms elapsed after all cars finished; -1 = not started

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
        _endScreenTimer = -1;

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
        if (phase === 'race_end')      { phaseTimer += adt;         return; }
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

        // No power-ups during qualifying — pure time trial

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
            // Start at 0.97 so pole car is before the line (1.0 wraps to 0.0 = last in sort)
            car.placeOnTrack(0.97 - i * 0.012, side * 16);
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

        // --- OVERTAKE TRACKING ---
        for (const car of cars) {
            car._overtakeCooldown = Math.max(0, (car._overtakeCooldown || 0) - dtSec);
            if (car._prevPosition > 0 && car.position < car._prevPosition && car._overtakeCooldown <= 0) {
                car.overtakes = (car.overtakes || 0) + 1;
                car._overtakeCooldown = 4.0;
            }
            car._prevPosition = car.position;
        }

        PowerUps.update(dtSec, cars, leader);

        for (const car of cars) {
            if (car.lap >= TOTAL_LAPS && !finishOrder.includes(car)) {
                finishOrder.push(car);
                car._finishedRace     = true;
                car._finishFadeDelay  = 2000;
                car._finishAlpha      = 1.0;
            }
        }

        // --- FINISH FADE ---
        for (const car of cars) {
            if (car._finishedRace) {
                if (car._finishFadeDelay > 0) {
                    car._finishFadeDelay -= adt;
                } else {
                    car._finishAlpha = Math.max(0, car._finishAlpha - adt / 1200);
                }
            }
        }

        // --- END-SCREEN TRIGGER ---
        if (finishOrder.length === cars.length) {
            if (_endScreenTimer < 0) _endScreenTimer = 0;
            _endScreenTimer += adt;
            if (_endScreenTimer > 4500) phase = 'race_end';
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
        } else if (phase === 'race_end') {
            _drawEndScreen(ctx, W, H, cx, cy);
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

        // Dark overlay
        const overlayAlpha = Math.min(1, t * 5) * 0.91;
        ctx.fillStyle = `rgba(4, 6, 22, ${overlayAlpha})`;
        ctx.fillRect(0, 0, W, H);

        // ── HEADER ──
        const headerT = Math.max(0, Math.min(1, t / 0.10));
        ctx.globalAlpha = headerT;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.save();
        ctx.translate(cx, cy - 195);
        const hs = 0.6 + 0.4 * headerT;
        ctx.scale(hs, hs);
        ctx.shadowColor = '#00d4ff';
        ctx.shadowBlur = 28;
        ctx.fillStyle = '#00d4ff';
        ctx.font = 'bold 38px Arial';
        ctx.fillText('QUALIFYING COMPLETE', 0, 0);
        ctx.shadowBlur = 0;
        ctx.fillStyle = 'rgba(160, 230, 255, 0.75)';
        ctx.font = '15px Arial';
        ctx.fillText('GRID POSITIONS LOCKED IN', 0, 40);
        ctx.restore();

        // ── RESULT ROWS ──
        const rowHeight = 50;   // spacing between row tops
        const rowH      = 42;   // visible row height
        const rowW      = 510;
        const rowX      = cx - rowW / 2;
        const listTop   = cy - 155;
        const rowRevealStart = 0.09;
        const rowRevealStep  = 0.08;

        for (let i = 0; i < qualifyingResults.length; i++) {
            const { car, lapTime } = qualifyingResults[i];
            const rowT = Math.max(0, Math.min(1, (t - rowRevealStart - i * rowRevealStep) / 0.09));
            if (rowT <= 0) continue;

            const rowY  = listTop + i * rowHeight;
            const midY  = rowY + rowH / 2;
            const slideX = (1 - rowT) * 320;

            ctx.save();
            ctx.globalAlpha = rowT;
            ctx.translate(slideX, 0);

            const colors  = CarSVG.TEAM_COLORS[car.team];
            const isFirst = i === 0;

            // Row background
            ctx.fillStyle = isFirst
                ? 'rgba(255, 215, 0, 0.14)'
                : (i % 2 === 0 ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.18)');
            ctx.beginPath();
            ctx.roundRect(rowX, rowY, rowW, rowH, 5);
            ctx.fill();

            // Left accent bar (team colour)
            ctx.fillStyle = colors.light;
            ctx.beginPath();
            ctx.roundRect(rowX, rowY, 5, rowH, [5, 0, 0, 5]);
            ctx.fill();

            // Team colour circle
            ctx.beginPath();
            ctx.arc(rowX + 28, midY, 9, 0, Math.PI * 2);
            ctx.fillStyle = colors.light;
            ctx.fill();
            ctx.strokeStyle = 'rgba(255,255,255,0.3)';
            ctx.lineWidth = 1.5;
            ctx.stroke();

            // Position
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.font = isFirst ? 'bold 22px Arial' : 'bold 14px Arial';
            ctx.fillStyle = isFirst ? '#ffd700' : 'rgba(255,255,255,0.45)';
            ctx.fillText(`P${i + 1}`, rowX + 46, midY);

            // Car name
            ctx.font = isFirst ? 'bold 20px Arial' : 'bold 15px Arial';
            ctx.fillStyle = isFirst ? '#ffffff' : colors.light;
            ctx.fillText(car.name, rowX + 90, midY);

            // Lap time (right-aligned)
            const timeStr = lapTime ? _formatTime(lapTime) : 'DNF';
            ctx.textAlign = 'right';

            if (i > 0 && lapTime && qualifyingResults[0].lapTime) {
                // Time on top line, gap below
                ctx.font = '15px monospace';
                ctx.fillStyle = '#dde8ff';
                ctx.fillText(timeStr, rowX + rowW - 16, midY - 8);
                const gap = lapTime - qualifyingResults[0].lapTime;
                ctx.font = '12px monospace';
                ctx.fillStyle = 'rgba(255, 110, 110, 0.9)';
                ctx.fillText(`+${_formatTime(gap)}`, rowX + rowW - 16, midY + 9);
            } else {
                ctx.font = isFirst ? 'bold 20px monospace' : '15px monospace';
                ctx.fillStyle = isFirst ? '#ffd700' : '#dde8ff';
                ctx.fillText(timeStr, rowX + rowW - 16, midY);
            }

            ctx.restore();
        }

        // ── RACE STARTS IN (last 4 seconds) ──
        const ctdwnStart = 1 - (4200 / TRANSITION_DURATION);
        const ctdwnT = Math.max(0, (t - ctdwnStart) / 0.06);
        if (ctdwnT > 0) {
            const remaining = Math.max(0, TRANSITION_DURATION - phaseTimer);
            ctx.globalAlpha = Math.min(1, ctdwnT);
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.shadowColor = '#ff4444';
            ctx.shadowBlur = 22;
            ctx.fillStyle = '#ff6060';
            ctx.font = 'bold 26px Arial';
            ctx.fillText(`RACE STARTS IN  ${(remaining / 1000).toFixed(1)}s`, cx, listTop + 8 * rowHeight + 28);
            ctx.shadowBlur = 0;
        }

        ctx.restore();
    }

    function _drawEndScreen(ctx, W, H, cx, cy) {
        ctx.save();

        // Full dark overlay
        ctx.fillStyle = 'rgba(4, 6, 22, 0.93)';
        ctx.fillRect(0, 0, W, H);

        const fadeIn = Math.min(1, phaseTimer / 600);
        ctx.globalAlpha = fadeIn;

        // ── TITLE ──
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = '#ffd700';
        ctx.shadowBlur = 30;
        ctx.fillStyle = '#ffd700';
        ctx.font = 'bold 42px Arial';
        ctx.fillText('RACE COMPLETE', cx, 54);
        ctx.shadowBlur = 0;

        // ── PODIUM (top 3) ──
        const podiumOrder = [1, 0, 2];  // draw P2, P1, P3 for visual height effect
        const podiumX     = [cx - 130, cx, cx + 130];
        const podiumBases = [cy - 40, cy - 80, cy - 20];  // P2 lower than P1, P3 lowest
        const podiumH     = [90, 130, 70];
        const medalColors = ['#C0C0C0', '#FFD700', '#CD7F32'];
        const podiumLabels = ['2ND', '1ST', '3RD'];

        for (let vi = 0; vi < 3; vi++) {
            const ri = podiumOrder[vi];
            if (ri >= finishOrder.length) continue;
            const car = finishOrder[ri];
            const px  = podiumX[vi];
            const base = podiumBases[vi] + cy - 50;
            const ph  = podiumH[vi];
            const col = CarSVG.TEAM_COLORS[car.team].light;
            const medal = medalColors[vi];

            // Podium block
            ctx.fillStyle = vi === 1 ? 'rgba(255,215,0,0.18)' : 'rgba(255,255,255,0.06)';
            ctx.fillRect(px - 50, base, 100, ph);
            ctx.strokeStyle = vi === 1 ? 'rgba(255,215,0,0.5)' : 'rgba(255,255,255,0.15)';
            ctx.lineWidth = 1;
            ctx.strokeRect(px - 50, base, 100, ph);

            // Medal circle
            ctx.beginPath();
            ctx.arc(px, base - 22, 16, 0, Math.PI * 2);
            ctx.fillStyle = medal;
            ctx.fill();
            ctx.fillStyle = '#000';
            ctx.font = 'bold 13px Arial';
            ctx.fillText(podiumLabels[vi], px, base - 22);

            // Car colour bar
            ctx.fillStyle = col;
            ctx.fillRect(px - 50, base, 5, ph);

            // Car name
            ctx.fillStyle = '#fff';
            ctx.font = `bold ${vi === 1 ? 14 : 12}px Arial`;
            ctx.fillText(car.name, px + 5, base + ph * 0.45);

            // Best lap
            if (car.bestLapTime < Infinity) {
                ctx.fillStyle = 'rgba(200,230,255,0.75)';
                ctx.font = '11px monospace';
                ctx.fillText(_formatTime(car.bestLapTime), px + 5, base + ph * 0.72);
            }
        }

        // ── FULL STANDINGS (right column) ──
        const listX = cx + 230, listTop = 100;
        ctx.textAlign = 'left';
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.font = 'bold 11px Arial';
        ctx.fillText('FINAL STANDINGS', listX, listTop - 14);

        for (let i = 0; i < finishOrder.length; i++) {
            const car = finishOrder[i];
            const ry = listTop + i * 36;
            const col = CarSVG.TEAM_COLORS[car.team].light;

            ctx.fillStyle = i < 3 ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.04)';
            ctx.fillRect(listX - 4, ry - 10, 200, 30);

            ctx.fillStyle = col;
            ctx.fillRect(listX - 4, ry - 10, 4, 30);

            ctx.fillStyle = i === 0 ? '#FFD700' : 'rgba(255,255,255,0.5)';
            ctx.font = 'bold 12px Arial';
            ctx.fillText(`P${i + 1}`, listX + 6, ry + 5);

            ctx.fillStyle = i < 3 ? '#fff' : 'rgba(255,255,255,0.75)';
            ctx.font = `${i < 3 ? 'bold ' : ''}12px Arial`;
            ctx.fillText(car.name, listX + 32, ry + 5);
        }

        // ── STATS (left column) ──
        const statsX = cx - W * 0.38, statsTop = cy + 110;
        ctx.textAlign = 'left';
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.font = 'bold 11px Arial';
        ctx.fillText('RACE STATS', statsX, statsTop - 14);

        // Fastest lap
        const flCar = [...cars].filter(c => c.bestLapTime < Infinity)
                               .sort((a,b) => a.bestLapTime - b.bestLapTime)[0];
        if (flCar) {
            _drawStatRow(ctx, statsX, statsTop,      '⚡ FASTEST LAP',
                `${flCar.name}`, _formatTime(flCar.bestLapTime), CarSVG.TEAM_COLORS[flCar.team].light);
        }

        // Most boosters by team
        const teamBoosters = {};
        for (const car of cars) {
            teamBoosters[car.team] = (teamBoosters[car.team] || 0) + (car.boostersCollected || 0);
        }
        const topTeamEntry = Object.entries(teamBoosters).sort((a,b) => b[1]-a[1])[0];
        if (topTeamEntry && topTeamEntry[1] > 0) {
            const [topTeam, topCount] = topTeamEntry;
            _drawStatRow(ctx, statsX, statsTop + 44, '🟡 MOST BOOSTERS',
                `${topTeam.charAt(0).toUpperCase()+topTeam.slice(1)} team`, `${topCount} pads`,
                CarSVG.TEAM_COLORS[topTeam].light);
        }

        // Most overtakes
        const topPasser = [...cars].sort((a,b) => (b.overtakes||0)-(a.overtakes||0))[0];
        if (topPasser && topPasser.overtakes > 0) {
            _drawStatRow(ctx, statsX, statsTop + 88, '🏎 MOST OVERTAKES',
                topPasser.name, `${topPasser.overtakes} passes`, CarSVG.TEAM_COLORS[topPasser.team].light);
        }

        ctx.restore();
    }

    function _drawStatRow(ctx, x, y, label, name, value, accentColor) {
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        ctx.fillRect(x - 4, y - 10, 210, 36);
        ctx.fillStyle = accentColor;
        ctx.fillRect(x - 4, y - 10, 4, 36);
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.font = 'bold 10px Arial';
        ctx.fillText(label, x + 6, y + 2);
        ctx.fillStyle = '#fff';
        ctx.font = '12px Arial';
        ctx.fillText(`${name}  —  ${value}`, x + 6, y + 17);
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
    function isFinished()        { return (phase === 'race' || phase === 'race_end') && finishOrder.length === cars.length; }
    function getTotalLaps()      { return TOTAL_LAPS; }
    function getSpeedMultiplier(){ return speedMultiplier; }
    function getPhase()          { return phase; }

    return {
        init, update, draw, getStandings, getTeamScores, getBestLaps,
        setSpeed, getCars, getLeader, getRaceTime, isStarted, isFinished,
        getTotalLaps, getSpeedMultiplier, getPhase
    };
})();
