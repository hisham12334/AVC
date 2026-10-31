import { useEffect, useState } from 'react';
import { DEMO_AVAILABLE, readRoute, switchMode } from '../mode';
import { Icon } from '../ui/ui';
import { api, staffToken, useApi, type ApiStaff } from './api';
import { LiveBoard, LiveJob, LiveOverview } from './LiveAdmin';
import { BillScreen } from './LiveTrack';
import { DriverComplete, DriverLegs } from './staff/Driver';
import { Intake } from './staff/Intake';
import { InspectionCapture, InspectionQueue } from './staff/Inspection';
import { PricingEditor, PricingQueue } from './staff/Pricing';
import { Loading, Problem } from './staff/common';

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
              Customers are not affected: their QR links and profiles work without any staff login.
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

type NavItem = { key: string; label: string; icon: string; href: string };
const OVERVIEW: NavItem = { key: 'overview', label: 'Overview', icon: 'grid', href: '#/' };
const INTAKE: NavItem = { key: 'intake', label: 'New intake', icon: 'plus', href: '#/intake' };
const PRICE: NavItem = { key: 'price', label: 'Quotes to price', icon: 'tool', href: '#/price' };
const INSPECT: NavItem = {
  key: 'inspect',
  label: 'Inspections',
  icon: 'camera',
  href: '#/inspect',
};
const JOBS: NavItem = { key: 'jobs', label: 'Job board', icon: 'list', href: '#/jobs' };
const LEGS: NavItem = { key: 'legs', label: 'My trips', icon: 'car', href: '#/legs' };

// Each person sees the screens for their own job and nothing else.
const NAV: Record<string, { items: NavItem[]; home: string }> = {
  lounge_manager: { items: [OVERVIEW, INTAKE, PRICE, JOBS], home: 'overview' },
  workshop_manager: { items: [OVERVIEW, INTAKE, INSPECT, JOBS], home: 'overview' },
  technician: { items: [INSPECT], home: 'inspect' },
  driver: { items: [LEGS], home: 'legs' },
  admin: { items: [OVERVIEW, JOBS], home: 'overview' },
  finance: { items: [OVERVIEW], home: 'overview' },
};

export default function LiveApp() {
  const [signedIn, setSignedIn] = useState(() => !!staffToken.get());
  if (!signedIn) return <Gate onToken={() => setSignedIn(true)} />;
  return <Signed onSignOut={() => setSignedIn(false)} />;
}

function Signed({ onSignOut }: { onSignOut: () => void }) {
  const me = useApi(() => api<{ staff: ApiStaff }>('/api/staff/me', { staff: true }), 'me');
  const [section, id] = useHashRoute();
  const signOut = () => {
    staffToken.set(null);
    onSignOut();
  };
  if (me.state.kind === 'loading') return <Loading />;
  if (me.state.kind === 'error')
    return (
      <div className="page">
        <Problem error={me.state.error} retry={me.reload} />
      </div>
    );
  const staff = me.state.data.staff;
  const nav = NAV[staff.role] ?? NAV.finance!;
  const current = section || nav.home;
  const active = current === 'bill' ? 'jobs' : current;

  let page;
  if (current === 'intake') page = <Intake />;
  else if (current === 'inspect') page = id ? <InspectionCapture id={id} /> : <InspectionQueue />;
  else if (current === 'price') page = id ? <PricingEditor id={id} /> : <PricingQueue />;
  else if (current === 'legs') page = id ? <DriverComplete id={id} /> : <DriverLegs />;
  else if (current === 'jobs') page = id ? <LiveJob id={id} /> : <LiveBoard />;
  else if (current === 'bill' && id)
    page = <BillScreen path={`/api/jobs/${id}/bill`} auth="staff" back={`#/jobs/${id}`} />;
  else page = <LiveOverview />;

  return (
    <div className="shell">
      <aside className="side">
        <div className="side-brand">
          <span className="brand-mark">AVC</span>
          <div>
            <strong>AVC Cloud</strong>
            <small>{staff.displayName}</small>
          </div>
        </div>
        <nav aria-label="Main">
          {nav.items.map((n) => (
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
        <div className="mobile-nav no-print">
          {nav.items.map((n) => (
            <a key={n.key} href={n.href} className={active === n.key ? 'on' : ''}>
              {n.label}
            </a>
          ))}
          <a href="#/" onClick={signOut}>
            Sign out
          </a>
        </div>
        {page}
      </div>
    </div>
  );
}
