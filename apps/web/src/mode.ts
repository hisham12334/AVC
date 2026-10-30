// The sample-data experience is only compiled in for `vite dev` or a build made with VITE_DEMO=1.
// A normal production build ships the live app and never offers fake records.
export const DEMO_AVAILABLE = import.meta.env.DEV || import.meta.env.VITE_DEMO === '1';

const MODE_KEY = 'avc.mode';
export type Mode = 'live' | 'demo';

export function readMode(): Mode {
  if (!DEMO_AVAILABLE) return 'live';
  try {
    return localStorage.getItem(MODE_KEY) === 'demo' ? 'demo' : 'live';
  } catch {
    return 'live';
  }
}

export function switchMode(mode: Mode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* without storage the choice only lasts until reload */
  }
  location.hash = '#/';
  location.reload();
}

// Routes are hash-based so the API can serve one static page. A customer link such as /track/<token>
// (the path the API returns) is also understood.
export function readRoute(): string[] {
  const path = location.pathname.match(/^\/track\/([^/]+)\/?$/);
  if (path) return ['track', decodeURIComponent(path[1]!)];
  return location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
}
