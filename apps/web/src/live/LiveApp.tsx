import { useEffect, useState } from 'react';
import { DEMO_AVAILABLE, readRoute, switchMode } from '../mode';
import { Icon } from '../ui/ui';
import { api, staffToken, useApi } from './api';
import { LiveBoard, LiveJob, LiveOverview } from './LiveAdmin';

function useHashRoute(): string[] {
  const [route, setRoute] = useState(readRoute);
  useEffect(() => {
    const on = () => {
      setRoute(readRoute());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

// Placeholder sign-in. Real staff sign-in needs the client's identity provider (open question 10);
// until then a verified bearer token can be pasted here, and the API still checks it.
function Gate({ onToken }: { onToken: () => void }) {
  const { state } = useApi(() => api<{ configured: boolean }>('/api/auth/status'), 'auth');
  const [value, setValue] = useState('');
  return (
    <div className="gate">
      <div className="card gate-card">
        <span className="brand-mark">AVC</span>
        <h1>Staff sign-in</h1>
        {state.kind === 'loading' && <p className="muted">Checking sign-in…</p>}
        {state.kind === 'error' && (
          <p className="banner banner-critical" role="alert">
            {state.error.message}
          </p>
        )}
        {state.kind === 'ready' && !state.data.configured && (
          <>
            <p className="muted">
              Staff sign-in is not set up yet. It needs AVC to choose an identity provider, so the
              workshop screens cannot open live records for now.
            </p>
            <p className="muted small">
              Customers are not affected: their tracking links work without any staff login.
            </p>
          </>
        )}
        {state.kind === 'ready' && state.data.configured && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!value.trim()) return;
              staffToken.set(value.trim());
              onToken();
            }}
          >
            <label className="field">
              <span>Access token</span>
              <input
                type="password"
                autoComplete="off"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </label>
            <button type="submit" className="btn primary lg" disabled={!value.trim()}>
              Continue
            </button>
          </form>
        )}
        {DEMO_AVAILABLE && (
          <button type="button" className="btn ghost" onClick={() => switchMode('demo')}>
            Open the sample-data demo
          </button>
        )}
      </div>
    </div>
  );
}

export default function LiveApp() {
  const [signedIn, setSignedIn] = useState(() => !!staffToken.get());
  const [section, id] = useHashRoute();
  if (!signedIn) return <Gate onToken={() => setSignedIn(true)} />;

  const nav = [
    { key: 'overview', label: 'Overview', icon: 'grid', href: '#/' },
    { key: 'jobs', label: 'Job board', icon: 'list', href: '#/jobs' },
  ];
  const active = section === 'jobs' ? 'jobs' : 'overview';
  const signOut = () => {
    staffToken.set(null);
    setSignedIn(false);
  };
  return (
    <div className="shell">
      <aside className="side">
        <div className="side-brand">
          <span className="brand-mark">AVC</span>
          <div>
            <strong>AVC Cloud</strong>
            <small>Workshop platform</small>
          </div>
        </div>
        <nav aria-label="Main">
          {nav.map((n) => (
            <a key={n.key} href={n.href} className={active === n.key ? 'on' : ''}>
              <Icon name={n.icon} size={18} />
              {n.label}
            </a>
          ))}
        </nav>
        <div className="side-demo">
          <button type="button" onClick={signOut}>
            Sign out
          </button>
          {DEMO_AVAILABLE && (
            <button type="button" onClick={() => switchMode('demo')}>
              Switch to sample-data demo
            </button>
          )}
        </div>
      </aside>
      <div className="main">
        <div className="mobile-nav">
          {nav.map((n) => (
            <a key={n.key} href={n.href} className={active === n.key ? 'on' : ''}>
              {n.label}
            </a>
          ))}
          <a href="#/" onClick={signOut}>
            Sign out
          </a>
        </div>
        {section === 'jobs' && id ? (
          <LiveJob id={id} />
        ) : section === 'jobs' ? (
          <LiveBoard />
        ) : (
          <LiveOverview />
        )}
      </div>
    </div>
  );
}
