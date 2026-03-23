/**
 * Race management: creates cars, runs the race loop, tracks positions.
 */
const Race = (() => {
    const TEAMS = ['blue', 'yellow', 'red', 'green'];
    const CARS_PER_TEAM = 2;
    const TOTAL_LAPS = 10;

    let cars = [];
    let raceTime = 0;
    let raceStarted = false;
    let raceFinished = false;
    let speedMultiplier = 1;
    let leader = null;
    let finishOrder = [];

    const TEAM_NUMBERS = {
        blue:   [1, 2],
        yellow: [3, 4],
        red:    [5, 6],
        green:  [7, 8]
    };

    function init() {
        cars = [];
        raceTime = 0;
        raceStarted = false;
        raceFinished = false;
        finishOrder = [];

        // Place cars in a 2-wide grid formation behind the start line
        let gridPos = 0;
        for (const team of TEAMS) {
            for (let i = 0; i < CARS_PER_TEAM; i++) {
                const num = TEAM_NUMBERS[team][i];
                const car = new Car(team, num);
                // Stagger: row = gridPos/2, col = gridPos%2
                const row = Math.floor(gridPos / 2);
                const col = gridPos % 2;
                const laneOffset = (col === 0 ? -12 : 12);
                // Each row is spaced ~0.012 of track progress apart
                const startProgress = 1 - row * 0.012;
                car.placeOnTrack(startProgress, laneOffset);
                gridPos++;
                cars.push(car);
            }
        }
    }

    function update(dt) {
        if (raceFinished) return;

        const adjustedDt = dt * speedMultiplier;
        raceTime += adjustedDt;

        // Countdown phase
        if (!raceStarted) {
            if (raceTime > 3000) {
                raceStarted = true;
            }
            return;
        }

        // Convert to seconds for physics
        const dtSec = adjustedDt / 1000;

        // Update all cars
        for (const car of cars) {
            car.update(dtSec, cars, raceTime);
        }

        // Sort by total progress for positions
        const sorted = [...cars].sort((a, b) => b.totalProgress - a.totalProgress);
        for (let i = 0; i < sorted.length; i++) {
            sorted[i].position = i + 1;
        }
        leader = sorted[0];

        // Check race finish
        for (const car of cars) {
            if (car.lap >= TOTAL_LAPS && !finishOrder.includes(car)) {
                finishOrder.push(car);
            }
        }
        if (finishOrder.length === cars.length) {
            raceFinished = true;
        }
    }

    function draw(ctx) {
        // Draw cars sorted by progress so cars "behind" render first
        const sorted = [...cars].sort((a, b) => a.totalProgress - b.totalProgress);
        for (const car of sorted) {
            car.draw(ctx);
        }

        // Countdown overlay
        if (!raceStarted) {
            const countdown = Math.ceil((3000 - raceTime) / 1000);
            ctx.save();
            const cx = ctx.canvas.width / 2, cy = ctx.canvas.height / 2;
            ctx.fillStyle = 'rgba(0,0,0,0.5)';
            ctx.beginPath();
            ctx.arc(cx, cy, 60, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = countdown > 0 ? '#fff' : '#4ecca3';
            ctx.font = 'bold 64px Arial';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(countdown > 0 ? countdown : 'GO!', cx, cy);
            ctx.restore();
        }
    }

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
            team: t,
            points: scores[t],
            colors: CarSVG.TEAM_COLORS[t]
        })).sort((a, b) => b.points - a.points);
    }

    function getBestLaps() {
        return [...cars]
            .filter(c => c.bestLapTime < Infinity)
            .sort((a, b) => a.bestLapTime - b.bestLapTime)
            .slice(0, 5);
    }

    function setSpeed(mult) { speedMultiplier = mult; }
    function getCars() { return cars; }
    function getLeader() { return leader; }
    function getRaceTime() { return raceTime; }
    function isStarted() { return raceStarted; }
    function isFinished() { return raceFinished; }
    function getTotalLaps() { return TOTAL_LAPS; }
    function getSpeedMultiplier() { return speedMultiplier; }

    return {
        init, update, draw, getStandings, getTeamScores, getBestLaps,
        setSpeed, getCars, getLeader, getRaceTime, isStarted, isFinished,
        getTotalLaps, getSpeedMultiplier
    };
})();
