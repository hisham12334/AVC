import { useEffect, useState } from 'react';
import { BRANCHES } from './data';
import { resetDemo } from './store';
import { Admin } from './Admin';
import { Board, JobDetail } from './Jobs';
import { Track } from './Track';
import { Icon } from '../ui/ui';
import { switchMode } from '../mode';

function useRoute(): string[] {
  const read = () => location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => {
      setRoute(read());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export default function DemoApp() {
  const route = useRoute();
  const [section, id] = route;

  if (section === 'track' && id) return <Track id={id} />;

  const nav = [
    { key: 'admin', label: 'Overview', icon: 'grid', href: '#/admin' },
    { key: 'jobs', label: 'Job board', icon: 'list', href: '#/jobs' },
  ];
  const active = section === 'jobs' ? 'jobs' : 'admin';

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
        <label className="branch">
          <span>Branch</span>
          <select aria-label="Branch" defaultValue={BRANCHES[0].id}>
            {BRANCHES.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
            <option disabled>+ Add branch (coming soon)</option>
          </select>
        </label>
        <nav aria-label="Main">
          {nav.map((n) => (
            <a key={n.key} href={n.href} className={active === n.key ? 'on' : ''}>
              <Icon name={n.icon} size={18} />
              {n.label}
            </a>
          ))}
        </nav>
        <div className="side-demo">
          <strong>Demo mode</strong>
          <p>Sample data. Try the customer experience:</p>
          <a href="#/track/j-1050">
            <Icon name="phone" size={14} /> Quote awaiting approval
          </a>
          <a href="#/track/j-1044">
            <Icon name="phone" size={14} /> Car in bay (raise a finding from the job page)
          </a>
          <button type="button" onClick={resetDemo}>
            Reset sample data
          </button>
          <button type="button" onClick={() => switchMode('live')}>
            Switch to live data
          </button>
        </div>
      </aside>
      <div className="main">
        <div className="mobile-nav">
          {nav.map((n) => (
            <a key={n.key} href={n.href} className={active === n.key ? 'on' : ''}>
              {n.label}
            </a>
          ))}
          <a href="#/track/j-1050">Customer view</a>
        </div>
        {section === 'jobs' && id ? (
          <JobDetail id={id} />
        ) : section === 'jobs' ? (
          <Board />
        ) : (
          <Admin />
        )}
      </div>
    </div>
  );
}
