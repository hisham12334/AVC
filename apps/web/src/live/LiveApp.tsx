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
import { ChangePassword } from './staff/Account';
import { Team } from './staff/Team';
import { CustomerProfile, Customers } from './staff/Customers';
import { Loading, Problem, messageOf } from './staff/common';

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

function Gate({ onSignedIn }: { onSignedIn: () => void }) {
  const [form, setForm] = useState({ email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="gate">
      <div className="card gate-card">
        <span className="brand-mark">AVC</span>
        <h1>Staff sign-in</h1>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              const r = await api<{ token: string }>('/api/auth/login', {
                method: 'POST',
                body: form,
              });
              staffToken.set(r.token);
              onSignedIn();
            } catch (err) {
              setError(messageOf(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <label className="field">
            <span>Email</span>
            <input
              type="email"
              required
              autoComplete="username"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              required
              autoComplete="current-password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </label>
          {error && (
            <p className="banner banner-critical" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="btn primary lg" disabled={busy}>
            {busy ? 'Signing in�' : 'Sign in'}
          </button>
        </form>
        <p className="muted small">
          Accounts are created by your super admin. Customers do not need a staff login: their QR
          links and profiles work on their own.
        </p>
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
const CUSTOMERS: NavItem = {
  key: 'customers',
  label: 'Customers',
  icon: 'user',
  href: '#/customers',
};
const TEAM: NavItem = { key: 'team', label: 'Team', icon: 'user', href: '#/team' };
const ACCOUNT: NavItem = { key: 'account', label: 'Account', icon: 'lock', href: '#/account' };
const LEGS: NavItem = { key: 'legs', label: 'My trips', icon: 'car', href: '#/legs' };

// Each person sees the screens for their own job and nothing else.
const NAV: Record<string, { items: NavItem[]; home: string }> = {
  lounge_manager: { items: [OVERVIEW, INTAKE, PRICE, JOBS, CUSTOMERS], home: 'overview' },
  workshop_manager: { items: [OVERVIEW, INTAKE, INSPECT, JOBS, CUSTOMERS], home: 'overview' },
  technician: { items: [INSPECT], home: 'inspect' },
  driver: { items: [LEGS], home: 'legs' },
  admin: { items: [OVERVIEW, JOBS, CUSTOMERS], home: 'overview' },
  finance: { items: [OVERVIEW], home: 'overview' },
  super_admin: { items: [OVERVIEW, JOBS, CUSTOMERS, TEAM], home: 'overview' },
};

export default function LiveApp() {
  const [signedIn, setSignedIn] = useState(() => !!staffToken.get());
  if (!signedIn) return <Gate onSignedIn={() => setSignedIn(true)} />;
  return <Signed onSignOut={() => setSignedIn(false)} />;
}

function Signed({ onSignOut }: { onSignOut: () => void }) {
  const me = useApi(() => api<{ staff: ApiStaff }>('/api/staff/me', { staff: true }), 'me');
  const [section, id] = useHashRoute();
  const signOut = () => {
    // Revoke the session on the server too; the screen signs out even if that call fails.
    void api('/api/auth/logout', { method: 'POST', staff: true }).catch(() => undefined);
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
  if (staff.mustChangePassword) return <ChangePassword forced onDone={me.reload} />;
  const base = NAV[staff.role] ?? NAV.finance!;
  const nav = { ...base, items: [...base.items, ACCOUNT] };
  const current = section || nav.home;
  const active = current === 'bill' ? 'jobs' : current;

  let page;
  if (current === 'account') page = <ChangePassword onDone={me.reload} />;
  else if (current === 'team' && staff.role === 'super_admin') page = <Team selfId={staff.id} />;
  else if (
    current === 'customers' &&
    ['admin', 'super_admin', 'lounge_manager', 'workshop_manager'].includes(staff.role)
  )
    page = id ? <CustomerProfile id={id} /> : <Customers />;
  else if (current === 'intake') page = <Intake />;
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
