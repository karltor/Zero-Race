/**
 * Procedural audio — no asset files, everything synthesised in WebAudio.
 *
 * Important for the YouTube workflow: WebAudio output *is* captured by tab /
 * desktop capture, whereas the speech-synthesis announcer on some browsers is
 * only captured by desktop audio. See README for the recording notes.
 */
const Audio2 = (() => {

    let ctx = null;
    let master = null;
    let engineGain = null;
    let engineOscs = [];
    let started = false;
    let enabled = true;
    let volume = 0.55;
    let noiseBuffer = null;

    function _ensure() {
        if (ctx) return ctx;
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = volume;
        master.connect(ctx.destination);

        // Shared white-noise buffer for all the percussive/atmospheric sounds.
        const len = ctx.sampleRate * 2;
        noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
        const data = noiseBuffer.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
        return ctx;
    }

    /** Must be called from a user gesture (browsers block audio otherwise). */
    function start() {
        if (!_ensure()) return;
        if (ctx.state === 'suspended') ctx.resume();
        if (started) return;
        started = true;
        _buildEngine();
    }

    function setEnabled(v) {
        enabled = !!v;
        if (master) master.gain.setTargetAtTime(enabled ? volume : 0, ctx.currentTime, 0.05);
    }
    function isEnabled() { return enabled; }
    function setVolume(v) {
        volume = Math.max(0, Math.min(1, v));
        if (master && enabled) master.gain.setTargetAtTime(volume, ctx.currentTime, 0.05);
    }

    // -------------------------------------------------------------------------
    // Engine bed — a low, always-on drone whose pitch tracks the on-screen action
    // -------------------------------------------------------------------------

    function _buildEngine() {
        engineGain = ctx.createGain();
        engineGain.gain.value = 0;

        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 900;
        filter.Q.value = 3;

        engineGain.connect(filter);
        filter.connect(master);

        for (const [type, detune, gain] of [['sawtooth', 0, 0.5], ['square', 7, 0.25], ['sawtooth', -11, 0.3]]) {
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.type = type;
            o.frequency.value = 70;
            o.detune.value = detune;
            g.gain.value = gain;
            o.connect(g);
            g.connect(engineGain);
            o.start();
            engineOscs.push({ osc: o, gain: g });
        }
    }

    /**
     * @param {number} speedFrac 0..1 how fast the cars on screen are going
     * @param {number} closeness 0..1 how close the camera is
     */
    function updateEngine(speedFrac, closeness) {
        if (!started || !engineGain || !enabled) return;
        const t = ctx.currentTime;
        const base = 58 + speedFrac * 105;
        for (let i = 0; i < engineOscs.length; i++) {
            engineOscs[i].osc.frequency.setTargetAtTime(base * (1 + i * 0.51), t, 0.08);
        }
        engineGain.gain.setTargetAtTime(0.028 + closeness * 0.075, t, 0.12);
    }

    function engineOff() {
        if (engineGain) engineGain.gain.setTargetAtTime(0, ctx.currentTime, 0.2);
    }

    // -------------------------------------------------------------------------
    // One-shots
    // -------------------------------------------------------------------------

    function _noise(duration, filterType, f0, f1, gain, q) {
        if (!started || !enabled) return;
        const src = ctx.createBufferSource();
        src.buffer = noiseBuffer;
        const flt = ctx.createBiquadFilter();
        flt.type = filterType;
        flt.Q.value = q || 1;
        const g = ctx.createGain();
        const t = ctx.currentTime;
        flt.frequency.setValueAtTime(f0, t);
        flt.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + duration);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(gain, t + duration * 0.15);
        g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
        src.connect(flt); flt.connect(g); g.connect(master);
        src.start(t);
        src.stop(t + duration + 0.05);
    }

    function _tone(freq0, freq1, duration, type, gain) {
        if (!started || !enabled) return;
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        const t = ctx.currentTime;
        o.type = type || 'sine';
        o.frequency.setValueAtTime(freq0, t);
        if (freq1 && freq1 !== freq0) o.frequency.exponentialRampToValueAtTime(freq1, t + duration);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(gain, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
        o.connect(g); g.connect(master);
        o.start(t);
        o.stop(t + duration + 0.05);
    }

    const SFX = {
        whoosh()   { _noise(0.45, 'bandpass', 1800, 320, 0.30, 2.5); },
        crash()    { _noise(0.55, 'lowpass', 2600, 120, 0.55, 1); _tone(120, 45, 0.4, 'square', 0.30); },
        spin()     { _noise(0.9, 'bandpass', 900, 2600, 0.22, 6); },
        boost()    { _tone(220, 900, 0.35, 'sawtooth', 0.16); },
        pit()      { _noise(0.7, 'bandpass', 2400, 2400, 0.14, 12); },
        beep()     { _tone(660, 660, 0.16, 'square', 0.20); },
        go()       { _tone(1040, 1040, 0.55, 'square', 0.26); },
        cheer(len) { _noise(len || 2.2, 'bandpass', 700, 1500, 0.20, 0.8); },
        fanfare() {
            [523, 659, 784, 1047].forEach((f, i) => {
                setTimeout(() => _tone(f, f, 0.42, 'triangle', 0.22), i * 130);
            });
        },
        drs()      { _tone(1400, 2000, 0.14, 'sine', 0.10); },
        thunder()  { _noise(1.6, 'lowpass', 400, 60, 0.42, 1); },
    };

    /** Map an event type straight to a sound. */
    function playForEvent(type, data) {
        if (!started || !enabled) return;
        switch (type) {
            case 'overtake':      SFX.whoosh(); SFX.cheer(1.4); break;
            case 'lead_change':   SFX.whoosh(); SFX.cheer(2.4); break;
            case 'crash':         SFX.crash(); break;
            case 'contact':       SFX.crash(); break;
            case 'spin':          SFX.spin(); break;
            case 'boost':         SFX.boost(); break;
            case 'pit_enter':
            case 'pit_exit':      SFX.pit(); break;
            case 'fastest_lap':   SFX.drs(); break;
            case 'dnf':           SFX.crash(); break;
            case 'sc_deploy':     SFX.thunder(); break;
            case 'weather_change': if (data && /RAIN/.test(data.to)) SFX.thunder(); break;
            case 'chequered':     SFX.fanfare(); SFX.cheer(3.5); break;
            default: break;
        }
    }

    return { start, setEnabled, isEnabled, setVolume, updateEngine, engineOff, SFX, playForEvent,
             get running() { return started; } };
})();
