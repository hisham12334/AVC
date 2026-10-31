import React, { lazy, Suspense, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './ui/theme.css';
import './ui/inputs.css';
import LiveApp from './live/LiveApp';
import { BillScreen, LiveTrack } from './live/LiveTrack';
import { customerToken } from './live/api';
import PortalApp from './live/portal/Portal';
import { DEMO_AVAILABLE, readMode, readRoute } from './mode';

const DemoApp = DEMO_AVAILABLE ? lazy(() => import('./demo/DemoApp')) : null;
const isDemoId = (id: string | undefined) => !!id && /^j-\d+$/.test(id);

// The QR/link a customer scans is /p/<token>. Keep the token for this tab only, then drop it from the
// address bar so it is not left in history or shared by accident.
function takeProfileLink(): boolean {
  const match = location.pathname.match(/^\/p\/([^/]+)\/?$/);
  if (!match) return false;
  customerToken.set(decodeURIComponent(match[1]!));
  history.replaceState(null, '', '/portal');
  return true;
}
const arrivedByQr = takeProfileLink();

function Root() {
  // Re-render when the hash changes (the per-job link has a bill page at #/bill).
  const [, tick] = useState(0);
  useEffect(() => {
    const on = () => tick((n) => n + 1);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  if (arrivedByQr || location.pathname.startsWith('/portal')) return <PortalApp />;
  const [section, id] = readRoute();
  // A per-job customer link opens the tracker. Sample ids (j-1050) only exist in the demo build.
  if (section === 'track' && id && !(DemoApp && isDemoId(id))) {
    if (location.hash.startsWith('#/bill'))
      return (
        <BillScreen path={`/api/track/${encodeURIComponent(id)}/bill`} auth="none" back="#/" />
      );
    return <LiveTrack token={id} />;
  }
  if (DemoApp && (readMode() === 'demo' || (section === 'track' && isDemoId(id))))
    return (
      <Suspense fallback={null}>
        <DemoApp />
      </Suspense>
    );
  return <LiveApp />;
}

// The service worker only caches the app shell; it never caches API or customer responses.
if ('serviceWorker' in navigator && !DEMO_AVAILABLE) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js');
  });
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
