import type { ReactNode } from 'react';
import { SEVERITY, type Severity } from '../ui/model';

const PATHS: Record<string, string> = {
  check: 'M20 6 9 17l-5-5',
  x: 'M18 6 6 18M6 6l12 12',
  clock: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 6v6l4 2',
  camera:
    'M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2zM12 9a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  alert:
    'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01',
  grid: 'M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  car: 'M5 11l1.5-4.5A2 2 0 0 1 8.4 5h7.2a2 2 0 0 1 1.9 1.5L19 11M3 11h18v6H3zM7 17v2M17 17v2',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  phone:
    'M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z',
  plus: 'M12 5v14M5 12h14',
  trend: 'M23 6l-9.5 9.5-5-5L1 18M17 6h6v6',
  building: 'M3 21h18M5 21V7l7-4 7 4v14M9 9h.01M9 13h.01M15 9h.01M15 13h.01',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  tool: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z',
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  pause: 'M6 4h4v16H6zM14 4h4v16h-4z',
};

export function Icon({ name, size = 18 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name] ?? PATHS.alert} />
    </svg>
  );
}

export const aed = (n: number, decimals = 0): string =>
  `AED ${n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;

export const fmtDate = (ms: number): string =>
  new Date(ms).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

export function ago(ms: number): string {
  const m = Math.max(1, Math.round((Date.now() - ms) / 60_000));
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function ageSeverity(days: number): Severity {
  return days >= 15 ? 'critical' : days >= 8 ? 'moderate' : 'minor';
}

export function SeverityBadge({ level, short }: { level: Severity; short?: boolean }) {
  return (
    <span className={`sev sev-${level}`}>
      <i aria-hidden="true" />
      {short ? SEVERITY[level].label.slice(0, 4) : SEVERITY[level].label}
    </span>
  );
}

export function Card({
  title,
  action,
  children,
  className = '',
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Kpi({
  label,
  value,
  sub,
  tone,
  icon,
  progress,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Severity;
  icon?: string;
  progress?: number;
}) {
  return (
    <div className={`kpi ${tone ? `tone-${tone}` : ''}`}>
      <div className="kpi-top">
        <span className="kpi-label">{label}</span>
        {icon && (
          <span className="kpi-icon">
            <Icon name={icon} size={16} />
          </span>
        )}
      </div>
      <div className="kpi-value">{value}</div>
      {progress !== undefined && (
        <div className="bar" role="presentation">
          <div style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} />
        </div>
      )}
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

export function Donut({
  parts,
  center,
  caption,
}: {
  parts: { value: number; cls: string; label: string }[];
  center: string;
  caption: string;
}) {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  const r = 52;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <svg viewBox="0 0 140 140" className="donut" role="img" aria-label={`${caption}: ${center}`}>
      <circle cx="70" cy="70" r={r} className="donut-track" />
      {parts.map((p) => {
        if (p.value === 0) return null;
        const len = (p.value / total) * c;
        const el = (
          <circle
            key={p.label}
            cx="70"
            cy="70"
            r={r}
            className={`donut-seg ${p.cls}`}
            strokeDasharray={`${Math.max(0, len - 3)} ${c - Math.max(0, len - 3)}`}
            strokeDashoffset={-offset}
            transform="rotate(-90 70 70)"
          />
        );
        offset += len;
        return el;
      })}
      <text x="70" y="68" textAnchor="middle" className="donut-num">
        {center}
      </text>
      <text x="70" y="86" textAnchor="middle" className="donut-cap">
        {caption}
      </text>
    </svg>
  );
}

export function RevenueChart({
  daily,
  target,
  days,
  projection,
}: {
  daily: number[];
  target: number;
  days: number;
  projection: number;
}) {
  const W = 640;
  const H = 230;
  const pad = { l: 46, r: 12, t: 12, b: 26 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const x = (d: number) => pad.l + (d / days) * iw;
  const y = (v: number) => pad.t + ih - (v / target) * ih;
  const pts = daily.map((v, i) => `${x(i + 1)},${y(v)}`);
  const area = `M${x(0)},${y(0)} L${pts.join(' L')} L${x(daily.length)},${y(0)} Z`;
  const last = daily[daily.length - 1];
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="chart"
      role="img"
      aria-label={`Cumulative revenue ${aed(last)} against a ${aed(target)} target`}
    >
      <defs>
        <linearGradient id="revfill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="var(--brand)" stopOpacity=".32" />
          <stop offset="1" stopColor="var(--brand)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={pad.l} x2={W - pad.r} y1={y(t * target)} y2={y(t * target)} className="grid" />
          <text x={pad.l - 8} y={y(t * target) + 4} textAnchor="end" className="axis">
            {t === 0 ? '0' : `${(t * target) / 1000}k`}
          </text>
        </g>
      ))}
      {[1, 7, 14, 21, 28].map((d) => (
        <text key={d} x={x(d)} y={H - 6} textAnchor="middle" className="axis">
          {d}
        </text>
      ))}
      <line x1={x(0)} y1={y(0)} x2={x(days)} y2={y(target)} className="target-line" />
      <path d={area} fill="url(#revfill)" />
      <polyline points={pts.join(' ')} className="actual-line" />
      <line
        x1={x(daily.length)}
        y1={y(last)}
        x2={x(days)}
        y2={y(projection)}
        className="proj-line"
      />
      <circle cx={x(daily.length)} cy={y(last)} r="5" className="dot" />
    </svg>
  );
}
