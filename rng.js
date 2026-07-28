/**
 * Deterministic pseudo-random number generation.
 *
 * Everything that affects the *simulation* must draw from a seeded stream so
 * that the same seed always produces the exact same race. That is what makes
 * the pre-simulation → commentary → replay pipeline possible.
 *
 * Purely cosmetic randomness (particles, camera shake, grass texture) may use
 * Math.random() freely — it never feeds back into the simulation.
 */
const Rng = (() => {

    /** mulberry32 — small, fast, good enough distribution, fully deterministic. */
    function mulberry32(a) {
        return function () {
            a |= 0; a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    /**
     * Create an independent random stream.
     * @param {number} seed 32-bit unsigned integer
     */
    function create(seed) {
        const next = mulberry32(seed >>> 0);
        let spare = null;

        return {
            seed: seed >>> 0,
            /** Uniform [0,1) */
            next,
            /** Uniform [a,b) */
            float(a = 0, b = 1) { return a + next() * (b - a); },
            /** Integer in [a,b] inclusive */
            int(a, b) { return a + Math.floor(next() * (b - a + 1)); },
            /** Random element of an array */
            pick(arr) { return arr[Math.floor(next() * arr.length)]; },
            /** True with probability p */
            chance(p) { return next() < p; },
            /** Standard normal (Box–Muller, cached spare) */
            gauss() {
                if (spare !== null) { const s = spare; spare = null; return s; }
                let u = 0, v = 0, s = 0;
                do {
                    u = next() * 2 - 1;
                    v = next() * 2 - 1;
                    s = u * u + v * v;
                } while (s >= 1 || s === 0);
                const m = Math.sqrt(-2 * Math.log(s) / s);
                spare = v * m;
                return u * m;
            },
            /** Fisher–Yates shuffle, in place, returns the array */
            shuffle(arr) {
                for (let i = arr.length - 1; i > 0; i--) {
                    const j = Math.floor(next() * (i + 1));
                    [arr[i], arr[j]] = [arr[j], arr[i]];
                }
                return arr;
            },
            /** Derive a new independent stream from this one (keeps sub-systems isolated). */
            fork() { return create((next() * 4294967296) >>> 0); },
        };
    }

    /** FNV-1a string hash → 32-bit seed. Lets humans use word seeds. */
    function hashString(str) {
        let h = 0x811c9dc5;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
        }
        return h >>> 0;
    }

    /** A fresh non-deterministic seed (only used when the user asks for a new race). */
    function randomSeed() {
        return (Math.random() * 4294967296) >>> 0;
    }

    /** Human-friendly seed code, e.g. 3735928559 → "AZR-XKQ2M1". */
    function toCode(seed) {
        return 'ZR-' + (seed >>> 0).toString(36).toUpperCase().padStart(7, '0');
    }

    /** Parse a seed from a user string: accepts "ZR-XXXXX", a raw number, or any word. */
    function fromCode(code) {
        if (code === null || code === undefined) return null;
        const s = String(code).trim();
        if (!s) return null;
        const m = s.match(/^ZR-([0-9A-Z]+)$/i);
        if (m) {
            const v = parseInt(m[1], 36);
            if (Number.isFinite(v)) return v >>> 0;
        }
        if (/^\d+$/.test(s)) return (parseInt(s, 10) >>> 0);
        return hashString(s.toLowerCase());
    }

    return { create, hashString, randomSeed, toCode, fromCode };
})();
