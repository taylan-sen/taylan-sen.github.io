// Party balloons that float up the screen, with a banner message.
//
//   launchBalloons('10 SQUATS!')
//
// Everything is created on the fly and removed when the animation ends.
// The overlay ignores clicks, so the page stays usable underneath.
// If the viewer's system asks for reduced motion, only the banner shows.

const COLORS = ['#582c83', '#b48ce6', '#f2c75c', '#7b3fb5', '#ffffff', '#e5b93f'];
const BALLOON_COUNT = 24;
const LONGEST_SECONDS = 9; // slowest balloon's rise time plus its start delay

const STYLES = `
  .party {
    position: fixed;
    inset: 0;
    pointer-events: none;
    overflow: hidden;
    z-index: 1000;
  }
  .party-banner {
    position: absolute;
    top: 30%;
    left: 50%;
    transform: translate(-50%, -50%);
    padding: 16px 28px;
    border-radius: 18px;
    background: rgba(42, 8, 69, 0.85);
    border: 3px solid #f2c75c;
    color: #f2c75c;
    font: 900 clamp(2rem, 9vw, 4.5rem) "Helvetica Neue", Arial, sans-serif;
    letter-spacing: 0.05em;
    white-space: nowrap;
    animation: party-banner 4s ease-out forwards;
  }
  @keyframes party-banner {
    0%   { opacity: 0; transform: translate(-50%, -50%) scale(0.5); }
    12%  { opacity: 1; transform: translate(-50%, -50%) scale(1.08); }
    20%  { transform: translate(-50%, -50%) scale(1); }
    80%  { opacity: 1; }
    100% { opacity: 0; }
  }

  /* Each balloon: the outer element rises, the inner one sways. */
  .balloon {
    position: absolute;
    bottom: -160px;
    left: var(--x);
    animation: balloon-rise var(--duration) ease-in var(--delay) forwards;
  }
  .balloon-body {
    position: relative;
    width: var(--size);
    height: calc(var(--size) * 1.22);
    border-radius: 50% 50% 48% 48% / 55% 55% 45% 45%;
    background: radial-gradient(circle at 32% 28%, rgba(255, 255, 255, 0.7), transparent 28%), var(--color);
    box-shadow: inset -6px -10px 0 rgba(0, 0, 0, 0.12);
    animation: balloon-sway 2.4s ease-in-out infinite alternate;
  }
  .balloon-body::before { /* the knot */
    content: "";
    position: absolute;
    left: 50%;
    bottom: -7px;
    transform: translateX(-50%);
    border: 6px solid transparent;
    border-bottom-color: var(--color);
  }
  .balloon-body::after { /* the string */
    content: "";
    position: absolute;
    left: 50%;
    top: 100%;
    width: 1.5px;
    height: 90px;
    margin-top: 5px;
    background: rgba(255, 255, 255, 0.6);
  }
  @keyframes balloon-rise {
    from { transform: translateY(0); }
    to   { transform: translateY(calc(-100vh - 320px)); }
  }
  @keyframes balloon-sway {
    from { transform: translateX(-14px) rotate(-6deg); }
    to   { transform: translateX(14px) rotate(6deg); }
  }

  @media (prefers-reduced-motion: reduce) {
    .balloon { display: none; }
    .party-banner { animation-duration: 4s; animation-name: party-fade; }
    @keyframes party-fade { 0%, 80% { opacity: 1; } 100% { opacity: 0; } }
  }
`;

function addStylesOnce() {
  if (document.getElementById('party-styles')) return;
  const style = document.createElement('style');
  style.id = 'party-styles';
  style.textContent = STYLES;
  document.head.appendChild(style);
}

const between = (low, high) => low + Math.random() * (high - low);

export function launchBalloons(message) {
  addStylesOnce();
  const party = document.createElement('div');
  party.className = 'party';
  party.setAttribute('aria-hidden', 'true'); // decoration only

  for (let i = 0; i < BALLOON_COUNT; i++) {
    const balloon = document.createElement('div');
    balloon.className = 'balloon';
    balloon.style.setProperty('--x', between(0, 95) + '%');
    balloon.style.setProperty('--size', Math.round(between(48, 80)) + 'px');
    balloon.style.setProperty('--color', COLORS[i % COLORS.length]);
    balloon.style.setProperty('--duration', between(4.5, 7).toFixed(2) + 's');
    balloon.style.setProperty('--delay', between(0, 1.8).toFixed(2) + 's');
    const body = document.createElement('div');
    body.className = 'balloon-body';
    body.style.animationDelay = (-between(0, 2.4)).toFixed(2) + 's'; // sway out of step
    balloon.appendChild(body);
    party.appendChild(balloon);
  }

  if (message) {
    const banner = document.createElement('div');
    banner.className = 'party-banner';
    banner.textContent = message;
    party.appendChild(banner);
  }

  document.body.appendChild(party);
  setTimeout(() => party.remove(), LONGEST_SECONDS * 1000);
}
