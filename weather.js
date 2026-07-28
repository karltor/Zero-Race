/**
 * Dynamic weather.
 *
 * The whole forecast is rolled from the seeded stream at creation time, so a
 * given seed always produces the same rain — including the moment it starts,
 * which is usually the most dramatic thing that can happen to a race.
 *
 * `rain` is what falls from the sky (0..1). `wetness` is the state of the
 * track surface, which lags behind: it soaks up quickly and dries slowly.
 * Grip is driven by wetness, not by rain.
 */
const Weather = (() => {

    const LABELS = [
        { max: 0.05, key: 'dry',        label: 'DRY',          icon: '☀' },
        { max: 0.28, key: 'damp',       label: 'DAMP',         icon: '☁' },
        { max: 0.60, key: 'light_rain', label: 'LIGHT RAIN',   icon: '🌦' },
        { max: 1.01, key: 'heavy_rain', label: 'HEAVY RAIN',   icon: '🌧' },
    ];

    function labelFor(v) {
        for (const l of LABELS) if (v <= l.max) return l;
        return LABELS[LABELS.length - 1];
    }

    /**
     * @param {object} rng      seeded stream
     * @param {number} expectedMs rough expected race duration, used to place the forecast
     */
    function create(rng, expectedMs) {
        const dur = Math.max(60000, expectedMs || 180000);

        // Roll the forecast: a sequence of {t, target} keyframes.
        const keys = [{ t: 0, rain: 0 }];
        const roll = rng.next();

        let headline;
        if (roll < 0.52) {
            // Dry race, maybe some cloud
            headline = 'Dry throughout';
        } else if (roll < 0.76) {
            // Rain arrives mid-race and stays
            const start = dur * rng.float(0.28, 0.60);
            keys.push({ t: start, rain: 0 });
            keys.push({ t: start + dur * 0.10, rain: rng.float(0.35, 0.70) });
            keys.push({ t: dur * 1.2, rain: rng.float(0.45, 0.85) });
            headline = 'Rain expected mid-race';
        } else if (roll < 0.90) {
            // Wet start, drying line
            keys[0].rain = rng.float(0.45, 0.80);
            keys.push({ t: dur * rng.float(0.20, 0.45), rain: rng.float(0.10, 0.30) });
            keys.push({ t: dur * rng.float(0.55, 0.80), rain: 0 });
            headline = 'Wet start, drying track';
        } else {
            // A passing shower — the strategy nightmare
            const start = dur * rng.float(0.20, 0.45);
            keys.push({ t: start, rain: 0 });
            keys.push({ t: start + dur * 0.07, rain: rng.float(0.50, 0.90) });
            keys.push({ t: start + dur * 0.28, rain: rng.float(0.50, 0.90) });
            keys.push({ t: start + dur * 0.40, rain: 0 });
            keys.push({ t: dur * 1.2, rain: 0 });
            headline = 'Shower passing through';
        }

        const state = {
            headline,
            rain: keys[0].rain,
            wetness: keys[0].rain > 0 ? Math.min(1, keys[0].rain * 1.1) : 0,
            t: 0,
            key: labelFor(keys[0].rain).key,
            label: labelFor(keys[0].rain).label,
            icon: labelFor(keys[0].rain).icon,
            /** True once the sky has ever opened up — used for commentary. */
            everRained: keys.some(k => k.rain > 0.2),
        };

        function sample(t) {
            if (t <= keys[0].t) return keys[0].rain;
            for (let i = 1; i < keys.length; i++) {
                if (t <= keys[i].t) {
                    const a = keys[i - 1], b = keys[i];
                    const f = (t - a.t) / Math.max(1, b.t - a.t);
                    return a.rain + (b.rain - a.rain) * f;
                }
            }
            return keys[keys.length - 1].rain;
        }

        return {
            state,
            /**
             * @param {number} dtSec
             * @param {object|null} events EventLog to report weather changes into
             * @param {number} simT current sim time, for the event stamp
             */
            step(dtSec, events, simT) {
                state.t += dtSec * 1000;
                state.rain = sample(state.t);

                // Surface soaks fast, dries slowly (and faster when there is no rain at all).
                const target = state.rain;
                const rate = target > state.wetness ? 0.30 : 0.055;
                state.wetness += (target - state.wetness) * Math.min(1, rate * dtSec);
                state.wetness = Math.max(0, Math.min(1, state.wetness));

                const l = labelFor(state.wetness);
                if (l.key !== state.key) {
                    const prev = state.label;
                    state.key = l.key; state.label = l.label; state.icon = l.icon;
                    if (events) events.add(simT, 'weather_change', { from: prev, to: l.label, wetness: state.wetness });
                }
            },
            /** Multiplier applied to every car's grip regardless of tyre choice. */
            surfaceGrip() { return 1 - state.wetness * 0.12; },
            isWet() { return state.wetness > 0.22; },
        };
    }

    return { create, labelFor, LABELS };
})();
