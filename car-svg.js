/**
 * Intricate SVG car rendering for top-down racing view.
 * Each car is drawn as a detailed race car with fake 3D shading.
 */
const CarSVG = (() => {
    // Pre-render car images for each team color
    const cache = {};

    const TEAM_COLORS = {
        blue:   { main: '#1565C0', light: '#42A5F5', dark: '#0D47A1', accent: '#BBDEFB' },
        yellow: { main: '#F9A825', light: '#FDD835', dark: '#F57F17', accent: '#FFF9C4' },
        red:    { main: '#C62828', light: '#EF5350', dark: '#8E0000', accent: '#FFCDD2' },
        green:  { main: '#2E7D32', light: '#66BB6A', dark: '#1B5E20', accent: '#C8E6C9' }
    };

    /**
     * Build an SVG string for a race car.
     * Size ~40x20 pixels, facing right.
     */
    function buildSVG(team, number) {
        const c = TEAM_COLORS[team];
        if (!c) return '';

        return `<svg xmlns="http://www.w3.org/2000/svg" width="52" height="28" viewBox="0 0 52 28">
  <defs>
    <linearGradient id="body-${team}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${c.light}"/>
      <stop offset="50%" stop-color="${c.main}"/>
      <stop offset="100%" stop-color="${c.dark}"/>
    </linearGradient>
    <linearGradient id="windshield-${team}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#aaddff" stop-opacity="0.9"/>
      <stop offset="100%" stop-color="#335577" stop-opacity="0.8"/>
    </linearGradient>
    <filter id="shadow-${team}">
      <feDropShadow dx="1" dy="1" stdDeviation="1.5" flood-opacity="0.5"/>
    </filter>
  </defs>

  <!-- Car shadow -->
  <ellipse cx="27" cy="16" rx="22" ry="9" fill="rgba(0,0,0,0.35)"/>

  <!-- Rear wing -->
  <rect x="1" y="3" width="4" height="22" rx="1" fill="${c.dark}" stroke="#222" stroke-width="0.5"/>
  <rect x="0" y="1" width="6" height="3" rx="1" fill="#333"/>
  <rect x="0" y="24" width="6" height="3" rx="1" fill="#333"/>

  <!-- Rear wing end plates -->
  <rect x="0" y="0" width="2" height="4" rx="0.5" fill="#444"/>
  <rect x="0" y="24" width="2" height="4" rx="0.5" fill="#444"/>

  <!-- Rear diffuser -->
  <path d="M5,6 L9,8 L9,20 L5,22 Z" fill="#222" opacity="0.7"/>

  <!-- Main body -->
  <path d="M8,5 Q12,2 26,2 Q42,2 48,10 L50,12 Q52,14 50,16 L48,18 Q42,26 26,26 Q12,26 8,23 Z"
        fill="url(#body-${team})" stroke="${c.dark}" stroke-width="0.8"
        filter="url(#shadow-${team})"/>

  <!-- Body side panels with 3D effect -->
  <path d="M10,6 Q14,3 26,3 Q40,3 46,10 L46,11 Q40,5 26,5 Q14,5 10,7 Z"
        fill="${c.light}" opacity="0.5"/>
  <path d="M10,22 Q14,25 26,25 Q40,25 46,18 L46,17 Q40,23 26,23 Q14,23 10,21 Z"
        fill="${c.dark}" opacity="0.4"/>

  <!-- Side air intakes -->
  <path d="M14,5 L20,4 L20,7 L14,7 Z" fill="#222" opacity="0.6"/>
  <path d="M14,23 L20,24 L20,21 L14,21 Z" fill="#222" opacity="0.6"/>

  <!-- Sidepod vents -->
  <g opacity="0.4">
    <line x1="18" y1="5" x2="18" y2="7" stroke="#111" stroke-width="0.5"/>
    <line x1="19" y1="5" x2="19" y2="7" stroke="#111" stroke-width="0.5"/>
    <line x1="18" y1="21" x2="18" y2="23" stroke="#111" stroke-width="0.5"/>
    <line x1="19" y1="21" x2="19" y2="23" stroke="#111" stroke-width="0.5"/>
  </g>

  <!-- Cockpit area -->
  <path d="M22,7 Q26,5 32,7 L34,9 Q34,14 34,19 L32,21 Q26,23 22,21 L20,18 Q20,14 20,10 Z"
        fill="#1a1a1a" stroke="#333" stroke-width="0.5"/>

  <!-- Windshield -->
  <path d="M30,8 Q33,10 33,14 Q33,18 30,20 L28,20 Q31,18 31,14 Q31,10 28,8 Z"
        fill="url(#windshield-${team})" opacity="0.8"/>

  <!-- Driver helmet -->
  <circle cx="26" cy="14" r="3.5" fill="${c.light}" stroke="#333" stroke-width="0.6"/>
  <path d="M24,12 Q26,10.5 28,12 L28,13 Q26,11.5 24,13 Z" fill="${c.accent}" opacity="0.7"/>
  <path d="M23.5,14.5 L28.5,14.5 Q28.5,15.5 26,15.5 Q23.5,15.5 23.5,14.5 Z"
        fill="#222" opacity="0.6"/>

  <!-- HALO device -->
  <path d="M23,11 Q22,14 23,17" stroke="#555" stroke-width="1.2" fill="none"/>

  <!-- Front nose -->
  <path d="M42,9 Q48,12 50,14 Q48,16 42,19 L42,9 Z"
        fill="${c.main}" stroke="${c.dark}" stroke-width="0.5"/>

  <!-- Front wing -->
  <path d="M46,6 Q50,8 52,10 L50,10 Q48,8 46,7 Z" fill="#333" stroke="#222" stroke-width="0.3"/>
  <path d="M46,22 Q50,20 52,18 L50,18 Q48,20 46,21 Z" fill="#333" stroke="#222" stroke-width="0.3"/>

  <!-- Front wing elements -->
  <line x1="47" y1="7" x2="51" y2="9.5" stroke="#555" stroke-width="0.4"/>
  <line x1="47" y1="21" x2="51" y2="18.5" stroke="#555" stroke-width="0.4"/>

  <!-- Wheels (with tire detail) -->
  <!-- Rear left -->
  <rect x="6" y="0" width="8" height="5" rx="1.5" fill="#111" stroke="#333" stroke-width="0.5"/>
  <line x1="7" y1="1" x2="13" y2="1" stroke="#2a2a2a" stroke-width="0.4"/>
  <line x1="7" y1="3.5" x2="13" y2="3.5" stroke="#2a2a2a" stroke-width="0.4"/>

  <!-- Rear right -->
  <rect x="6" y="23" width="8" height="5" rx="1.5" fill="#111" stroke="#333" stroke-width="0.5"/>
  <line x1="7" y1="24.5" x2="13" y2="24.5" stroke="#2a2a2a" stroke-width="0.4"/>
  <line x1="7" y1="27" x2="13" y2="27" stroke="#2a2a2a" stroke-width="0.4"/>

  <!-- Front left -->
  <rect x="40" y="2" width="7" height="4" rx="1.2" fill="#111" stroke="#333" stroke-width="0.5"/>
  <line x1="41" y1="3.5" x2="46" y2="3.5" stroke="#2a2a2a" stroke-width="0.4"/>

  <!-- Front right -->
  <rect x="40" y="22" width="7" height="4" rx="1.2" fill="#111" stroke="#333" stroke-width="0.5"/>
  <line x1="41" y1="24.5" x2="46" y2="24.5" stroke="#2a2a2a" stroke-width="0.4"/>

  <!-- Wheel hub details -->
  <circle cx="10" cy="2.5" r="1" fill="#888" stroke="#555" stroke-width="0.3"/>
  <circle cx="10" cy="25.5" r="1" fill="#888" stroke="#555" stroke-width="0.3"/>
  <circle cx="43.5" cy="4" r="0.8" fill="#888" stroke="#555" stroke-width="0.3"/>
  <circle cx="43.5" cy="24" r="0.8" fill="#888" stroke="#555" stroke-width="0.3"/>

  <!-- Racing number on sidepod -->
  <circle cx="18" cy="14" r="4" fill="white" opacity="0.85"/>
  <text x="18" y="16.5" text-anchor="middle" font-size="7" font-weight="bold"
        font-family="Arial,sans-serif" fill="#111">${number}</text>

  <!-- Sponsor stripes -->
  <line x1="30" y1="6" x2="40" y2="8" stroke="${c.accent}" stroke-width="1" opacity="0.6"/>
  <line x1="30" y1="22" x2="40" y2="20" stroke="${c.accent}" stroke-width="1" opacity="0.6"/>

  <!-- Exhaust glow -->
  <circle cx="5" cy="11" r="1.2" fill="#ff6600" opacity="0.5"/>
  <circle cx="5" cy="17" r="1.2" fill="#ff6600" opacity="0.5"/>

  <!-- Antenna / T-cam -->
  <rect x="22" y="13" width="1.5" height="2" rx="0.3"
        fill="${number % 2 === 0 ? '#ffff00' : '#111'}"
        stroke="#333" stroke-width="0.3"/>

  <!-- Rain light -->
  <rect x="3" y="12.5" width="2" height="3" rx="0.5" fill="#ff3333" opacity="0.7"/>
</svg>`;
    }

    /**
     * Get a pre-rendered Image for a given team/number combo.
     */
    function getImage(team, number) {
        const key = `${team}-${number}`;
        if (cache[key]) return cache[key];

        const svg = buildSVG(team, number);
        const blob = new Blob([svg], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.src = url;
        cache[key] = img;
        return img;
    }

    return { getImage, TEAM_COLORS };
})();
