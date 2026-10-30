import React, { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import './ui/theme.css';
import LiveApp from './live/LiveApp';
import { LiveTrack } from './live/LiveTrack';
import { DEMO_AVAILABLE, readMode, readRoute } from './mode';

const DemoApp = DEMO_AVAILABLE ? lazy(() => import('./demo/DemoApp')) : null;
const isDemoId = (id: string | undefined) => !!id && /^j-\d+$/.test(id);

function Root() {
  const [section, id] = readRoute();
  // A customer link opens the tracker. Sample ids (j-1050) only exist in the demo build.
  if (section === 'track' && id && !(DemoApp && isDemoId(id))) return <LiveTrack token={id} />;
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
