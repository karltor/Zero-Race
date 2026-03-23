/**
 * Sidebar UI updates for race information display.
 */
const Sidebar = (() => {
    const standingsEl = document.getElementById('standings');
    const teamScoresEl = document.getElementById('team-scores');
    const bestLapsEl = document.getElementById('best-laps');
    const raceLapEl = document.getElementById('race-lap');
    const raceLeaderEl = document.getElementById('race-leader');

    let lastUpdate = 0;
    const UPDATE_INTERVAL = 200; // ms between sidebar refreshes

    function update(timestamp) {
        if (timestamp - lastUpdate < UPDATE_INTERVAL) return;
        lastUpdate = timestamp;

        updateRaceInfo();
        updateStandings();
        updateTeamScores();
        updateBestLaps();
    }

    function updateRaceInfo() {
        const leader = Race.getLeader();
        if (leader) {
            const maxLap = Math.min(leader.lap + 1, Race.getTotalLaps());
            raceLapEl.textContent = `${maxLap} / ${Race.getTotalLaps()}`;
            raceLeaderEl.textContent = leader.name;
            raceLeaderEl.style.color = CarSVG.TEAM_COLORS[leader.team].light;
        }

        if (Race.isFinished()) {
            raceLapEl.textContent = 'FINISHED';
        }
    }

    function updateStandings() {
        const standings = Race.getStandings();
        let html = '';

        for (let i = 0; i < standings.length; i++) {
            const car = standings[i];
            const colors = CarSVG.TEAM_COLORS[car.team];
            const isLeader = i === 0;
            const gap = getGapText(standings, i);
            const lapInfo = `L${Math.min(car.lap + 1, Race.getTotalLaps())}`;

            html += `
                <div class="standing-row${isLeader ? ' leader' : ''}">
                    <span class="standing-pos">${i + 1}</span>
                    <span class="standing-color" style="background:${colors.main}"></span>
                    <span class="standing-name" style="color:${colors.light}">#${car.number}</span>
                    <span class="standing-info">${lapInfo} ${formatTime(car.currentLapTime)}</span>
                    <span class="standing-gap">${gap}</span>
                </div>`;
        }

        standingsEl.innerHTML = html;
    }

    function getGapText(standings, idx) {
        if (idx === 0) return '';
        const leader = standings[0];
        const car = standings[idx];
        const lapDiff = leader.lap - car.lap;

        if (lapDiff > 0) {
            return `+${lapDiff} lap${lapDiff > 1 ? 's' : ''}`;
        }

        const progDiff = (leader.lap + leader.progress) - (car.lap + car.progress);
        const timeDiff = progDiff * 15000; // rough time estimate
        return `+${(timeDiff / 1000).toFixed(1)}s`;
    }

    function updateTeamScores() {
        const scores = Race.getTeamScores();
        let html = '';

        for (const s of scores) {
            const bg = `rgba(${hexToRgb(s.colors.main)}, 0.2)`;
            html += `
                <div class="team-row" style="background:${bg}">
                    <span class="standing-color" style="background:${s.colors.main}"></span>
                    <span class="team-name" style="color:${s.colors.light};margin-left:8px">
                        ${s.team.charAt(0).toUpperCase() + s.team.slice(1)}
                    </span>
                    <span class="team-points" style="color:${s.colors.light}">${s.points} pts</span>
                </div>`;
        }

        teamScoresEl.innerHTML = html;
    }

    function updateBestLaps() {
        const bests = Race.getBestLaps();
        let html = '';

        for (let i = 0; i < bests.length; i++) {
            const car = bests[i];
            const colors = CarSVG.TEAM_COLORS[car.team];
            const medal = i === 0 ? ' style="color:#ffd700"' : '';

            html += `
                <div class="best-lap-row">
                    <span class="standing-color" style="background:${colors.main}"></span>
                    <span style="color:${colors.light}">#${car.number}</span>
                    <span class="best-lap-time"${medal}>${formatTime(car.bestLapTime)}</span>
                </div>`;
        }

        if (bests.length === 0) {
            html = '<div class="best-lap-row" style="color:#666">Waiting...</div>';
        }

        bestLapsEl.innerHTML = html;
    }

    function formatTime(ms) {
        if (!ms || ms === Infinity) return '--:--.---';
        const totalSec = ms / 1000;
        const min = Math.floor(totalSec / 60);
        const sec = totalSec % 60;
        return `${min}:${sec.toFixed(1).padStart(4, '0')}`;
    }

    function hexToRgb(hex) {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `${r},${g},${b}`;
    }

    return { update };
})();
