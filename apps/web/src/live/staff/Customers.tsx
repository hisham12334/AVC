import { useEffect, useState } from 'react';
import { Qr } from '../../ui/evidence';
import { Card, Icon } from '../../ui/ui';
import { api, useApi, type ApiCustomer, type ApiCustomerProfile } from '../api';
import { Loading, Page, Problem, stageLabel } from './common';

type Directory = {
  total: number;
  page: number;
  pageSize: number;
  customers: (ApiCustomer & { createdAt: string })[];
};

const date = (value: string) =>
  new Date(value).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
const staffLink = (id: string) => `${location.origin}/#/customers/${id}`;

export function Customers() {
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(input.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [input]);
  const { state, reload } = useApi(
    () =>
      api<Directory>(`/api/customers/directory?query=${encodeURIComponent(query)}&page=${page}`, {
        staff: true,
      }),
    `${query}:${page}`,
  );
  return (
    <Page title="Customers" eyebrow="Customer directory">
      <Card title="Find a customer">
        <label className="field">
          <span>Search by name, mobile or email</span>
          <input
            type="search"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Name, mobile number or email"
          />
        </label>
      </Card>
      {state.kind === 'loading' ? (
        <Loading />
      ) : state.kind === 'error' ? (
        <Problem error={state.error} retry={reload} />
      ) : (
        <Card title={`${state.data.total} ${state.data.total === 1 ? 'customer' : 'customers'}`}>
          {state.data.customers.length === 0 ? (
            <p className="empty">No customers found.</p>
          ) : (
            <ul className="queue">
              {state.data.customers.map((customer) => (
                <li key={customer.id}>
                  <a className="qcard" href={`#/customers/${customer.id}`}>
                    <div className="qcard-top">
                      <strong>{customer.fullName}</strong>
                      <span className="qcard-go">
                        View <Icon name="arrow" size={14} />
                      </span>
                    </div>
                    <div className="qcard-foot">
                      <span>{customer.mobileNumber}</span>
                      <span>{customer.email}</span>
                      <span className="muted small">Added {date(customer.createdAt)}</span>
                    </div>
                  </a>
                </li>
              ))}
            </ul>
          )}
          {state.data.total > state.data.pageSize && (
            <div className="customer-pages">
              <button
                className="btn"
                type="button"
                disabled={page === 1}
                onClick={() => setPage(page - 1)}
              >
                Previous
              </button>
              <span>
                Page {page} of {Math.ceil(state.data.total / state.data.pageSize)}
              </span>
              <button
                className="btn"
                type="button"
                disabled={page * state.data.pageSize >= state.data.total}
                onClick={() => setPage(page + 1)}
              >
                Next
              </button>
            </div>
          )}
        </Card>
      )}
    </Page>
  );
}

export function CustomerProfile({ id }: { id: string }) {
  const { state, reload } = useApi(
    () => api<ApiCustomerProfile>(`/api/customers/${encodeURIComponent(id)}`, { staff: true }),
    id,
  );
  if (state.kind === 'loading')
    return (
      <Page title="Customer">
        <Loading />
      </Page>
    );
  if (state.kind === 'error')
    return (
      <Page title="Customer">
        <Problem error={state.error} retry={reload} />
      </Page>
    );
  const { customer, vehicles, jobs } = state.data;
  return (
    <Page
      title={customer.fullName}
      eyebrow="Customer profile"
      aside={
        <a className="btn" href="#/customers">
          ← All customers
        </a>
      }
    >
      <div className="grid-2 even">
        <Card title="Contact details">
          <dl className="dl">
            <div>
              <dt>Name</dt>
              <dd>{customer.fullName}</dd>
            </div>
            <div>
              <dt>Mobile</dt>
              <dd>
                <a href={`tel:${customer.mobileNumber}`}>{customer.mobileNumber}</a>
              </dd>
            </div>
            <div>
              <dt>Email</dt>
              <dd>
                <a href={`mailto:${customer.email}`}>{customer.email}</a>
              </dd>
            </div>
            <div>
              <dt>Customer since</dt>
              <dd>{date(customer.createdAt)}</dd>
            </div>
          </dl>
        </Card>
        <Card title="Staff scan code">
          <div className="qr-block">
            <Qr value={staffLink(customer.id)} />
            <div>
              <p className="muted small">
                Scan to open this customer's company record. Staff sign-in is required.
              </p>
              <a className="link" href={`#/customers/${customer.id}`}>
                Open profile
              </a>
            </div>
          </div>
        </Card>
      </div>
      <Card title={`Cars (${vehicles.length})`}>
        {vehicles.length === 0 ? (
          <p className="empty">No cars recorded.</p>
        ) : (
          <ul className="queue">
            {vehicles.map((vehicle) => (
              <li className="qcard" key={vehicle.id}>
                <strong>
                  {[vehicle.modelYear, vehicle.make, vehicle.model].filter(Boolean).join(' ')}
                </strong>
                <p className="muted small">
                  Plate: {vehicle.licensePlate || '—'} · VIN: {vehicle.vin || '—'} · Color:{' '}
                  {vehicle.color || '—'}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title={`Visit history (${jobs.length})`}>
        {jobs.length === 0 ? (
          <p className="empty">No visits yet.</p>
        ) : (
          <ul className="queue">
            {jobs.map((job) => (
              <li key={job.id}>
                <a className="qcard" href={`#/jobs/${job.id}`}>
                  <div className="qcard-top">
                    <strong>
                      AVC-{job.jobNumber} · {job.make} {job.model}
                    </strong>
                    <span className="qcard-go">
                      View job <Icon name="arrow" size={14} />
                    </span>
                  </div>
                  <div className="qcard-foot">
                    <span>{date(job.createdAt)}</span>
                    <span className="chip">{stageLabel(job.stage)}</span>
                    <span>{job.mileageKm.toLocaleString()} km</span>
                  </div>
                  <p className="muted small">{job.intakeCondition}</p>
                </a>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Page>
  );
}
