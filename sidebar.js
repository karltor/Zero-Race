/**
 * Control room — the DOM panel.
 *
 * Deliberately kept out of the canvas so it can be hidden with one key press
 * when recording: the broadcast itself is 100% canvas.
 */
const Controls = (() => {

    const $ = id => document.getElementById(id);

    let hooks = {};
    let panelOpen = false;

    // -------------------------------------------------------------------------

    function init(callbacks) {
        hooks = callbacks || {};

        // ── Panel visibility ──
        $('panel-toggle').addEventListener('click', toggle);
        $('panel-close').addEventListener('click', () => setOpen(false));

        // ── Race controls ──
        $('btn-new').addEventListener('click', () => {
            const raw = $('seed-input').value.trim();
            const s = raw ? Rng.fromCode(raw) : Rng.randomSeed();
            hooks.onNewRace && hooks.onNewRace(s, _laps());
        });

        $('btn-replay').addEventListener('click', () => {
            hooks.onNewRace && hooks.onNewRace(Race.getSeed(), _laps());
        });

        $('btn-pause').addEventListener('click', () => {
            const paused = hooks.onTogglePause ? hooks.onTogglePause() : false;
            $('btn-pause').textContent = paused ? '▶ RESUME' : '⏸ PAUSE';
        });

        $('btn-skip').addEventListener('click', () => Race.skipToResults());

        $('speed-seg').addEventListener('click', e => {
            const btn = e.target.closest('button');
            if (!btn) return;
            [...$('speed-seg').children].forEach(b => b.classList.toggle('on', b === btn));
            Race.setSpeed(parseFloat(btn.dataset.speed));
        });

        $('laps-input').addEventListener('change', () => Race.setTotalLaps(_laps()));

        // ── Broadcast controls ──
        $('tgl-announcer').addEventListener('change', e => Commentary.setEnabled(e.target.checked));
        $('rate-input').addEventListener('input', e => Commentary.setRate(parseFloat(e.target.value)));
        $('voice-select').addEventListener('change', e => Commentary.setVoiceByName(e.target.value));
        $('tgl-sfx').addEventListener('change', e => Audio2.setEnabled(e.target.checked));
        $('vol-input').addEventListener('input', e => Audio2.setVolume(parseFloat(e.target.value)));
        $('tgl-camera').addEventListener('change', e => Camera.setEnabled(e.target.checked));

        // ── Garage / votes / season ──
        $('btn-tally').addEventListener('click', _tallyVotes);
        $('btn-reset-season').addEventListener('click', () => {
            if (!confirm('Reset the whole season? All upgrades and championship points are lost.')) return;
            Garage.reset();
            renderGarage();
            renderChampionship();
        });

        $('garage').addEventListener('click', e => {
            const el = e.target.closest('.upg');
            if (!el || el.classList.contains('maxed')) return;
            if (Garage.buy(el.dataset.team, el.dataset.upg)) {
                renderGarage();
                renderChampionship();
            }
        });

        // ── Keyboard ──
        window.addEventListener('keydown', e => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
            if (e.key === 'h' || e.key === 'H') { toggle(); e.preventDefault(); }
            if (e.code === 'Space') {
                const paused = hooks.onTogglePause ? hooks.onTogglePause() : false;
                $('btn-pause').textContent = paused ? '▶ RESUME' : '⏸ PAUSE';
                e.preventDefault();
            }
            if (e.key === 'n' || e.key === 'N') hooks.onNewRace && hooks.onNewRace(Rng.randomSeed(), _laps());
            if (e.key === 'c' || e.key === 'C') {
                const on = !Camera.isEnabled();
                Camera.setEnabled(on);
                $('tgl-camera').checked = on;
            }
        });

        _populateVoices();
        if (window.speechSynthesis) {
            window.speechSynthesis.addEventListener('voiceschanged', _populateVoices);
        }

        renderGarage();
        renderChampionship();
    }

    function _laps() {
        const v = parseInt($('laps-input').value, 10);
        return Number.isFinite(v) ? Math.max(3, Math.min(60, v)) : 14;
    }

    function _populateVoices() {
        const sel = $('voice-select');
        const voices = Commentary.listVoices();
        if (!voices.length) { sel.innerHTML = '<option>System default</option>'; return; }
        const cur = sel.value;
        sel.innerHTML = voices.map(v => `<option value="${v.name}">${v.name} (${v.lang})</option>`).join('');
        if (cur && voices.some(v => v.name === cur)) sel.value = cur;
    }

    // -------------------------------------------------------------------------

    function setOpen(v) {
        panelOpen = v;
        $('panel').classList.toggle('hidden', !v);
        if (v) { renderGarage(); renderChampionship(); }
    }
    function toggle() { setOpen(!panelOpen); }
    function isOpen() { return panelOpen; }

    function setSeedLabel(seed, extra) {
        $('seed-hint').textContent = `Current: ${Rng.toCode(seed)}${extra ? '  ·  ' + extra : ''}`;
        $('seed-input').value = Rng.toCode(seed);
    }

    // -------------------------------------------------------------------------
    // Garage rendering
    // -------------------------------------------------------------------------

    function renderGarage() {
        const el = $('garage');
        if (!el) return;
        let html = '';
        for (const team of Garage.TEAMS) {
            const info = Garage.getTeam(team);
            const col = CarSVG.TEAM_COLORS[team];
            html += `<div class="team-card">
                <div class="team-head">
                    <span class="team-dot" style="background:${col.main}"></span>
                    <span class="team-name" style="color:${col.light}">${team.toUpperCase()}</span>
                    <span class="team-bank">${info.bank} pts</span>
                </div>
                <div class="upg-grid">`;
            for (const u of Garage.CATALOG) {
                const lvl = info.upgrades[u.id] || 0;
                const maxed = lvl >= Garage.MAX_LEVEL;
                const cost = Garage.costFor(team, u.id);
                const afford = !maxed && info.bank >= cost;
                html += `<div class="upg ${maxed ? 'maxed' : ''} ${afford ? 'afford' : ''}"
                              data-team="${team}" data-upg="${u.id}" title="${u.blurb}">
                    <span>${u.icon}</span>
                    <span class="upg-name">${u.name}</span>
                    <span class="upg-lvl">${'▮'.repeat(lvl)}${'▯'.repeat(Garage.MAX_LEVEL - lvl)}</span>
                    <span class="upg-cost">${maxed ? 'MAX' : cost}</span>
                </div>`;
            }
            html += '</div></div>';
        }
        el.innerHTML = html;
    }

    function renderChampionship() {
        const el = $('championship');
        if (!el) return;
        const table = Garage.championshipTable();
        el.innerHTML = table.map((t, i) => {
            const col = CarSVG.TEAM_COLORS[t.team];
            return `<div class="champ-row">
                <span class="team-dot" style="background:${col.main}"></span>
                <span class="champ-name" style="color:${col.light}">${t.team.toUpperCase()}</span>
                <span class="champ-sub">${t.wins}W · ${t.podiums}P · ${t.fastestLaps}FL</span>
                <span class="champ-pts">${t.championship}</span>
            </div>`;
        }).join('') + `<p class="hint">Round ${Garage.getRaceNumber()} · results are saved in this browser.</p>`;
    }

    // -------------------------------------------------------------------------
    // Votes
    // -------------------------------------------------------------------------

    function _tallyVotes() {
        const text = $('vote-box').value;
        const { votes, counted, ignored } = Garage.parseVotes(text);
        const applied = Garage.applyVotes(votes);

        let html = `<strong>${counted}</strong> votes counted, ${ignored} lines ignored.`;
        if (applied.length) {
            html += '<br>Fitted: ' + applied.map(a => {
                const u = Garage.CATALOG_BY_ID[a.upgradeId];
                return `${a.team} ${u.name} → lvl ${a.level}`;
            }).join(' · ');
        } else {
            html += '<br>Nothing bought — teams could not afford the most-voted upgrade yet.';
        }
        $('vote-result').innerHTML = html;

        renderGarage();
        renderChampionship();
    }

    /** Called after every race so the panel reflects the new points. */
    function onRaceResult() {
        renderGarage();
        renderChampionship();
    }

    return { init, setOpen, toggle, isOpen, setSeedLabel, renderGarage, renderChampionship, onRaceResult };
})();
