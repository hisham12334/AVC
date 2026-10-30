import { KPI, STAGES, dailyRevenue, type Severity } from './data';
import { hasPausedWork, isAwaitingCustomer, useJobs } from './store';
import { Card, Donut, Icon, Kpi, RevenueChart, SeverityBadge, aed, ago } from '../ui/ui';

const marginTone = (cogsPct: number): Severity =>
  cogsPct >= 90 ? 'critical' : cogsPct >= 50 ? 'moderate' : 'minor';

export function Admin() {
  const jobs = useJobs().filter((j) => j.stage !== 'delivered');
  const daily = dailyRevenue();
  const awaiting = jobs.filter((j) => isAwaitingCustomer(j));
  const buckets = {
    fresh: jobs.filter((j) => j.ageDays <= 3).length,
    standard: jobs.filter((j) => j.ageDays >= 4 && j.ageDays <= 7).length,
    delayed: jobs.filter((j) => j.ageDays >= 8 && j.ageDays <= 14).length,
    critical: jobs.filter((j) => j.ageDays >= 15).length,
  };
  const stageCounts = STAGES.filter((s) => s.key !== 'delivered').map((s) => ({
    ...s,
    count: jobs.filter((j) => j.stage === s.key).length,
  }));
  const maxCount = Math.max(1, ...stageCounts.map((s) => s.count));
  const attention = jobs
    .flatMap((j) => {
      const out: { job: typeof j; level: Severity; text: string }[] = [];
      if (hasPausedWork(j))
        out.push({
          job: j,
          level: 'critical',
          text: 'Work paused — new finding awaiting customer',
        });
      if (j.ageDays >= 15)
        out.push({ job: j, level: 'critical', text: `${j.ageDays} days in workshop` });
      else if (j.ageDays >= 8)
        out.push({ job: j, level: 'moderate', text: `${j.ageDays} days in workshop` });
      if (j.stage === 'quote' && isAwaitingCustomer(j))
        out.push({
          job: j,
          level: 'moderate',
          text: `Quote sent ${ago(j.events.at(-1)?.at ?? j.createdAt)} — awaiting approval`,
        });
      return out;
    })
    .sort((a, b) => (a.level === b.level ? 0 : a.level === 'critical' ? -1 : 1));

  const achievement = (KPI.grossSales / KPI.target) * 100;
  const cycleTone: Severity = KPI.cycleDays > KPI.cycleTarget * 1.25 ? 'critical' : 'moderate';
  const atvPct = (KPI.atv / KPI.atvTarget) * 100;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">
            AVC Al Quoz 1 · Day {KPI.day} of {KPI.daysInMonth}
          </p>
          <h1>Operations overview</h1>
        </div>
        <span className="pill">
          <Icon name="clock" size={14} /> Report date {KPI.reportDate}
        </span>
      </div>

      <div className="kpi-grid">
        <Kpi
          label="Cars in workshop"
          icon="car"
          value={
            <>
              {jobs.length}
              <small> / {KPI.capacity} bays</small>
            </>
          }
          progress={(jobs.length / KPI.capacity) * 100}
          sub={`${Math.round((jobs.length / KPI.capacity) * 100)}% capacity used`}
        />
        <Kpi
          label="Awaiting customer"
          icon="clock"
          tone={awaiting.length ? 'moderate' : undefined}
          value={awaiting.length}
          sub="Quotes or new findings to approve"
        />
        <Kpi
          label="Revenue this month"
          icon="trend"
          value={aed(KPI.grossSales)}
          progress={achievement}
          sub={`${achievement.toFixed(1)}% of ${aed(KPI.target)} target`}
        />
        <Kpi
          label="Average ticket"
          icon="tool"
          tone="moderate"
          value={aed(KPI.atv)}
          progress={atvPct}
          sub={`Target ${aed(KPI.atvTarget)} · ${atvPct.toFixed(0)}%`}
        />
        <Kpi
          label="Avg repair cycle"
          icon="clock"
          tone={cycleTone}
          value={
            <>
              {KPI.cycleDays}
              <small> days</small>
            </>
          }
          sub={`Target ${KPI.cycleTarget} days`}
        />
        <Kpi
          label="Delivered this month"
          icon="check"
          value={KPI.deliveredMtd}
          sub={`${KPI.complaints} complaints · ${KPI.reviews}/${KPI.reviewsTarget} 5-star reviews`}
        />
      </div>

      <div className="grid-2">
        <Card
          title="Revenue vs monthly target"
          action={
            <span className="legend">
              <i className="lg-actual" />
              Actual
              <i className="lg-proj" />
              Projection
              <i className="lg-target" />
              Target
            </span>
          }
        >
          <RevenueChart
            daily={daily}
            target={KPI.target}
            days={KPI.daysInMonth}
            projection={KPI.projection}
          />
          <div className="stat-row">
            <div>
              <span>Run rate</span>
              <strong>{aed(KPI.runRate)} / day</strong>
            </div>
            <div>
              <span>Month-end projection</span>
              <strong>{aed(KPI.projection)}</strong>
            </div>
            <div>
              <span>Remaining to target</span>
              <strong>{aed(KPI.remaining)}</strong>
            </div>
            <div>
              <span>Gross profit</span>
              <strong>
                {aed(KPI.grossProfit)} · {KPI.gpMargin}%
              </strong>
            </div>
          </div>
        </Card>

        <Card title="How long cars have been here">
          <div className="donut-wrap">
            <Donut
              center={`${jobs.length}`}
              caption="cars"
              parts={[
                { value: buckets.fresh, cls: 'seg-blue', label: '0-3' },
                { value: buckets.standard, cls: 'seg-sky', label: '4-7' },
                { value: buckets.delayed, cls: 'seg-yellow', label: '8-14' },
                { value: buckets.critical, cls: 'seg-red', label: '15+' },
              ]}
            />
            <ul className="legend-list">
              <li>
                <i className="seg-blue" />
                0–3 days<b>{buckets.fresh}</b>
              </li>
              <li>
                <i className="seg-sky" />
                4–7 days<b>{buckets.standard}</b>
              </li>
              <li>
                <i className="seg-yellow" />
                8–14 days<b>{buckets.delayed}</b>
              </li>
              <li>
                <i className="seg-red" />
                15+ days<b>{buckets.critical}</b>
              </li>
            </ul>
          </div>
        </Card>
      </div>

      <div className="grid-2 even">
        <Card
          title="Live pipeline"
          action={
            <a className="link" href="#/jobs">
              Open board <Icon name="arrow" size={14} />
            </a>
          }
        >
          <ul className="pipeline">
            {stageCounts.map((s) => (
              <li key={s.key}>
                <span>{s.label}</span>
                <div className="bar thick">
                  <div style={{ width: `${(s.count / maxCount) * 100}%` }} />
                </div>
                <b>{s.count}</b>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Needs attention">
          {attention.length === 0 ? (
            <p className="empty">Nothing needs attention right now.</p>
          ) : (
            <ul className="attention">
              {attention.slice(0, 7).map((a, i) => (
                <li key={`${a.job.id}-${i}`}>
                  <a href={`#/jobs/${a.job.id}`}>
                    <SeverityBadge level={a.level} />
                    <span className="a-main">
                      <strong>
                        {a.job.vehicle.make} {a.job.vehicle.model}
                      </strong>
                      <small>
                        AVC-{a.job.number} · {a.text}
                      </small>
                    </span>
                    <Icon name="arrow" size={14} />
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid-2 even">
        <Card title="Department margin">
          <table className="table">
            <thead>
              <tr>
                <th>Department</th>
                <th className="num">Sales</th>
                <th className="num">COGS</th>
                <th className="num">COGS / sales</th>
              </tr>
            </thead>
            <tbody>
              {KPI.departments.map((d) => {
                const pct = (d.cogs / d.sales) * 100;
                return (
                  <tr key={d.name}>
                    <td>{d.name}</td>
                    <td className="num">{aed(d.sales)}</td>
                    <td className="num">{aed(d.cogs)}</td>
                    <td className="num">
                      <span className={`sev sev-${marginTone(pct)}`}>
                        <i />
                        {pct.toFixed(1)}%
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>

        <Card title="Enquiry funnel">
          <div className="funnel">
            <div className="funnel-main">
              <strong>{KPI.funnel.enquiries}</strong>
              <span>enquiries</span>
            </div>
            <div className="funnel-main">
              <strong>{KPI.funnel.converted}</strong>
              <span>converted · {KPI.funnel.rate}%</span>
            </div>
          </div>
          <div className="chips">
            <span className="chip">{KPI.funnel.activeDialog} active dialogue</span>
            <span className="chip">{KPI.funnel.followUp} need follow-up</span>
            <span className="chip">{KPI.funnel.pendingContact} pending contact</span>
          </div>
          <p className="note">
            Funnel data arrives from the CRM integration. Until it is connected, this panel is fed
            by manual entry.
          </p>
        </Card>
      </div>
      <p className="note footnote">
        Financial and funnel figures are the client&rsquo;s sample numbers from the {KPI.reportDate}{' '}
        daily report. Live jobs, stages and approvals are simulated and update as you act on them.
      </p>
    </div>
  );
}
