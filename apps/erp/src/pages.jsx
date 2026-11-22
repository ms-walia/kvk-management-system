import React, { useState } from 'react';
import { api, inr, fmtDate } from './api.js';
import { useLoad, Badge, Modal, ActionForm, Field, ErrorBox, Loading, Empty, Tabs } from './ui.jsx';
import { TRAINING_CATEGORIES, MAX_FORM_BYTES } from '../../../shared/backend.js';
import { DEMO_TRAINING_DOCS, DEMO_TRAINING_STEPS } from '../../../shared/demo-data.js';

const Stat = ({ label, value, tone, onClick }) => (
  <button className={`stat ${tone || ''}`} onClick={onClick} disabled={!onClick}>
    <div className="stat-v">{value}</div><div className="stat-l">{label}</div>
  </button>
);

// ---------------- Dashboard ----------------
export function Dashboard({ go, kvkKey }) {
  const [d, err] = useLoad('/erp/dashboard', [kvkKey]);
  if (err) return <ErrorBox error={err} />;
  if (!d) return <Loading />;
  if (d.scope === 'national') {
    return (
      <>
        <h2>National overview</h2>
        <div className="stats">
          <Stat label="Active KVKs" value={d.kvks} onClick={() => go('kvks')} />
          <Stat label="Verified farmers" value={d.farmers_verified} />
          <Stat label="Farmers awaiting verification" value={d.farmers_pending} tone="warn" />
          <Stat label="Booking requests" value={d.bookings_requested} tone="warn" />
          <Stat label="Equipment out now" value={d.equipment_out} />
          <Stat label="Rental income this month" value={inr(d.revenue_month)} />
        </div>
        <div className="card">
          <h3>KVKs by state</h3>
          <table><tbody>{d.by_state.map((s) => <tr key={s.state}><td>{s.state}</td><td className="num">{s.kvks}</td></tr>)}</tbody></table>
          <p className="muted">Choose a KVK in the top bar to manage its inventory and bookings.</p>
        </div>
      </>
    );
  }
  return (
    <>
      <h2>{d.kvk.name} <span className="muted small">{d.kvk.district}, {d.kvk.state}</span></h2>
      <div className="stats">
        <Stat label="Booking requests to review" value={d.bookings_requested} tone={d.bookings_requested ? 'warn' : ''} onClick={() => go('bookings')} />
        <Stat label="Farmers to verify" value={d.farmers_pending} tone={d.farmers_pending ? 'warn' : ''} onClick={() => go('farmers')} />
        <Stat label="Equipment out now" value={d.equipment_out} onClick={() => go('equipment')} />
        <Stat label="Overdue returns" value={d.overdue} tone={d.overdue ? 'bad' : ''} onClick={() => go('bookings')} />
        <Stat label="Verified farmers" value={d.farmers_verified} />
        <Stat label="Rental income this month" value={inr(d.revenue_month)} />
      </div>
      <div className="grid2">
        <div className="card">
          <h3>Due for pickup</h3>
          {d.today_pickups.length ? <MiniList rows={d.today_pickups} date="start_date" /> : <Empty>No pickups due.</Empty>}
        </div>
        <div className="card">
          <h3>Due back</h3>
          {d.today_returns.length ? <MiniList rows={d.today_returns} date="end_date" /> : <Empty>Nothing due back.</Empty>}
        </div>
        <div className="card">
          <h3>Low or out of stock</h3>
          {d.low_stock.length ? (
            <table><tbody>{d.low_stock.map((s) => (
              <tr key={s.id}><td>{s.name}</td><td className="num">{s.quantity} {s.unit}</td><td><Badge s={s.quantity <= 0 ? 'out' : 'low'} /></td></tr>
            ))}</tbody></table>
          ) : <Empty>All stock above reorder level.</Empty>}
        </div>
      </div>
    </>
  );
}
const MiniList = ({ rows, date }) => (
  <table><tbody>{rows.map((r) => (
    <tr key={r.id}><td>{r.equipment_name}{r.qty > 1 ? ` ×${r.qty}` : ''}</td><td>{r.farmer_name}<div className="muted small">{r.phone}</div></td><td>{fmtDate(r[date])}</td></tr>
  ))}</tbody></table>
);

// ---------------- Bookings ----------------
export function Bookings({ kvkKey }) {
  const [tab, setTab] = useState('active');
  const [rows, err, reload] = useLoad(`/erp/bookings?status=${tab}`, [kvkKey]);
  const [dialog, setDialog] = useState(null);
  const [rowErr, setRowErr] = useState(null);
  const today = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);

  const act = async (b, action, body) => {
    setRowErr(null);
    try { await api(`/erp/bookings/${b.id}/${action}`, { method: 'POST', body }); setDialog(null); reload(); }
    catch (e) { if (dialog) throw e; setRowErr(`Booking ${b.ref}: ${e.message}`); }
  };

  return (
    <>
      <h2>Equipment bookings</h2>
      <Tabs value={tab} onChange={setTab} options={[['active', 'Active'], ['requested', 'Requests'], ['issued', 'Out now'], ['returned', 'Returned'], ['rejected', 'Rejected'], ['cancelled', 'Cancelled']]} />
      <ErrorBox error={err || rowErr} />
      {!rows ? <Loading /> : !rows.length ? <Empty>No bookings here.</Empty> : (
        <div className="card flush"><table className="table">
          <thead><tr><th>#</th><th>Farmer</th><th>Equipment</th><th>Dates</th><th className="num">Amount</th><th>Status</th><th></th></tr></thead>
          <tbody>{rows.map((b) => (
            <tr key={b.id}>
              <td className="muted small">{b.ref}</td>
              <td>{b.farmer_name}<div className="muted small">{b.phone} · {b.village}</div></td>
              <td>{b.equipment_name}{b.qty > 1 ? ` ×${b.qty}` : ''}{b.farmer_note && <div className="muted small">“{b.farmer_note}”</div>}</td>
              <td>{fmtDate(b.start_date)} – {fmtDate(b.end_date)}
                {b.status === 'issued' && b.end_date < today && <div className="badge b-rejected">Overdue</div>}
              </td>
              <td className="num">{inr(b.amount)}</td>
              <td><Badge s={b.status} />
                {b.status === 'requested' && <div className={`small ${b.available >= b.qty ? 'ok' : 'bad'}`}>{b.available >= b.qty ? `${b.available} free on these dates` : 'Clashes with approved booking'}</div>}
                {b.staff_note && <div className="muted small">{b.staff_note}</div>}
              </td>
              <td className="actions">
                {b.status === 'requested' && <>
                  <button className="primary sm" onClick={() => act(b, 'approve')} disabled={b.available < b.qty}>Approve</button>
                  <button className="sm" onClick={() => setDialog({ b, kind: 'reject' })}>Reject</button>
                </>}
                {b.status === 'approved' && <>
                  <button className="primary sm" onClick={() => act(b, 'issue')}>Hand over</button>
                  <button className="sm" onClick={() => setDialog({ b, kind: 'reject' })}>Cancel</button>
                </>}
                {b.status === 'issued' && <button className="primary sm" onClick={() => setDialog({ b, kind: 'return' })}>Mark returned</button>}
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {dialog?.kind === 'reject' && (
        <Modal title={`Reject booking ${dialog.b.ref}`} onClose={() => setDialog(null)}>
          <ActionForm danger submitLabel="Reject booking" onSubmit={(f) => act(dialog.b, 'reject', f)}>
            <Field label="Reason (shown to the farmer)"><textarea name="note" required rows={3} placeholder="e.g. Machine under repair, please book after 5 Dec" /></Field>
          </ActionForm>
        </Modal>
      )}
      {dialog?.kind === 'return' && (
        <Modal title={`Return: ${dialog.b.equipment_name}`} onClose={() => setDialog(null)}>
          <ActionForm submitLabel="Confirm return" onSubmit={(f) => act(dialog.b, 'return', f)}>
            <Field label="Condition">
              <select name="condition" defaultValue="good"><option value="good">Good</option><option value="minor_damage">Minor damage</option><option value="damaged">Damaged, needs repair</option></select>
            </Field>
            <Field label="Note (optional)"><input name="note" /></Field>
          </ActionForm>
        </Modal>
      )}
    </>
  );
}

// ---------------- Equipment ----------------
const CATEGORIES = ['Tractor', 'Tillage', 'Sowing', 'Transplanting', 'Land preparation', 'Plant protection', 'Harvesting', 'Livestock', 'Irrigation', 'Testing', 'Other'];

export function Equipment({ kvkKey, canEdit }) {
  const [rows, err, reload] = useLoad('/erp/equipment', [kvkKey]);
  const [edit, setEdit] = useState(null);
  const [cal, setCal] = useState(null);
  const save = async (f) => {
    const body = { ...f, daily_rate: Number(f.daily_rate), total_qty: Number(f.total_qty), max_days: Number(f.max_days), active: f.active === 'on' };
    if (edit.id) await api(`/erp/equipment/${edit.id}`, { method: 'PUT', body });
    else await api('/erp/equipment', { method: 'POST', body });
    setEdit(null); reload();
  };
  return (
    <>
      <div className="row"><h2>Rental equipment</h2>{canEdit && <button className="primary" onClick={() => setEdit({ active: 1, total_qty: 1, max_days: 3, daily_rate: 0 })}>+ Add equipment</button>}</div>
      <ErrorBox error={err} />
      {!rows ? <Loading /> : !rows.length ? <Empty>No equipment yet. Add the machines this KVK rents out.</Empty> : (
        <div className="card flush"><table className="table">
          <thead><tr><th>Equipment</th><th>Category</th><th className="num">Rate / day</th><th className="num">Units</th><th className="num">Free today</th><th className="num">Out</th><th></th></tr></thead>
          <tbody>{rows.map((e) => (
            <tr key={e.id} className={e.active ? '' : 'inactive'}>
              <td><b>{e.name}</b>{!e.active && <span className="badge b-cancelled">Hidden</span>}<div className="muted small">{e.description}</div></td>
              <td>{e.category}</td>
              <td className="num">{inr(e.daily_rate)}</td>
              <td className="num">{e.total_qty}</td>
              <td className="num"><b className={e.available_today ? 'ok' : 'bad'}>{e.available_today}</b></td>
              <td className="num">{e.out_now}{e.pending_requests > 0 && <div className="small warn">{e.pending_requests} req.</div>}</td>
              <td className="actions"><button className="sm" onClick={() => setCal(e)}>Calendar</button>{canEdit && <button className="sm" onClick={() => setEdit(e)}>Edit</button>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {edit && (
        <Modal title={edit.id ? `Edit ${edit.name}` : 'Add equipment'} onClose={() => setEdit(null)}>
          <ActionForm onSubmit={save}>
            <Field label="Name"><input name="name" defaultValue={edit.name} required /></Field>
            <Field label="Category"><select name="category" defaultValue={edit.category || 'Tillage'}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></Field>
            <Field label="Description"><input name="description" defaultValue={edit.description || ''} /></Field>
            <div className="grid3">
              <Field label="Rent per day (₹)"><input name="daily_rate" type="number" min="0" step="1" defaultValue={edit.daily_rate} required /></Field>
              <Field label="Units owned"><input name="total_qty" type="number" min="0" step="1" defaultValue={edit.total_qty} required /></Field>
              <Field label="Max days per booking"><input name="max_days" type="number" min="1" step="1" defaultValue={edit.max_days} required /></Field>
            </div>
            <label className="check"><input type="checkbox" name="active" defaultChecked={!!edit.active} /> Show to farmers</label>
          </ActionForm>
        </Modal>
      )}
      {cal && <CalendarModal equipment={cal} onClose={() => setCal(null)} />}
    </>
  );
}

function CalendarModal({ equipment, onClose }) {
  const [d, err] = useLoad(`/erp/equipment/${equipment.id}/calendar`);
  return (
    <Modal title={`${equipment.name}: next 14 days`} onClose={onClose}>
      <ErrorBox error={err} />
      {!d ? <Loading /> : <>
        <div className="cal">{d.days.map((x) => (
          <div key={x.date} className={`cal-day ${x.available === 0 ? 'full' : x.used ? 'part' : ''}`}>
            <div className="small">{new Date(x.date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short' })}</div>
            <b>{fmtDate(x.date)}</b>
            <div className="small">{x.available}/{d.equipment.total_qty} free</div>
          </div>
        ))}</div>
        <h4>Bookings in this period</h4>
        {d.bookings.length ? <table><tbody>{d.bookings.map((b) => (
          <tr key={b.id}><td>{fmtDate(b.start_date)} – {fmtDate(b.end_date)}</td><td>{b.farmer_name}{b.qty > 1 ? ` ×${b.qty}` : ''}</td><td><Badge s={b.status} /></td></tr>
        ))}</tbody></table> : <Empty>None.</Empty>}
      </>}
    </Modal>
  );
}

// ---------------- Stock ----------------
const TYPE_LABEL = { feed: 'Feed', fertilizer: 'Fertilizer', seed: 'Seed', other: 'Other' };

export function Stock({ kvkKey, canEdit }) {
  const [type, setType] = useState('');
  const [rows, err, reload] = useLoad(`/erp/stock${type ? `?type=${type}` : ''}`, [kvkKey]);
  const [edit, setEdit] = useState(null);
  const [adjust, setAdjust] = useState(null);
  const [history, setHistory] = useState(null);

  const save = async (f) => {
    const body = { ...f, price_per_unit: Number(f.price_per_unit), reorder_level: Number(f.reorder_level), certified: f.certified === 'on', active: f.active === 'on' };
    if (edit.id) { delete body.quantity; await api(`/erp/stock/${edit.id}`, { method: 'PUT', body }); }
    else await api('/erp/stock', { method: 'POST', body: { ...body, quantity: Number(f.quantity) } });
    setEdit(null); reload();
  };
  const doAdjust = async (f) => {
    const sign = ['received'].includes(f.reason) ? 1 : f.reason === 'correction' && f.direction === 'add' ? 1 : -1;
    await api(`/erp/stock/${adjust.item.id}/adjust`, { method: 'POST', body: { change: sign * Math.abs(Number(f.qty)), reason: f.reason, note: f.note } });
    setAdjust(null); reload();
  };

  return (
    <>
      <div className="row"><h2>Feeds, fertilizers and seeds</h2>{canEdit && <button className="primary" onClick={() => setEdit({ type: type || 'feed', unit: 'kg', quantity: 0, price_per_unit: 0, reorder_level: 0, certified: 1, active: 1 })}>+ Add item</button>}</div>
      <Tabs value={type} onChange={setType} options={[['', 'All'], ['feed', 'Feeds'], ['fertilizer', 'Fertilizers'], ['seed', 'Seeds'], ['other', 'Other']]} />
      <ErrorBox error={err} />
      {!rows ? <Loading /> : !rows.length ? <Empty>No items.</Empty> : (
        <div className="card flush"><table className="table">
          <thead><tr><th>Item</th><th>Type</th><th className="num">In stock</th><th className="num">Price</th><th>Level</th><th></th></tr></thead>
          <tbody>{rows.map((s) => {
            const level = s.quantity <= 0 ? 'out' : s.quantity <= s.reorder_level ? 'low' : 'in';
            return (
              <tr key={s.id} className={s.active ? '' : 'inactive'}>
                <td><b>{s.name}</b>{s.certified ? <span className="badge b-verified">KVK certified</span> : null}</td>
                <td>{TYPE_LABEL[s.type]}</td>
                <td className="num"><b>{s.quantity}</b> {s.unit}<div className="muted small">reorder at {s.reorder_level}</div></td>
                <td className="num">{inr(s.price_per_unit)}/{s.unit}</td>
                <td><Badge s={level} /></td>
                <td className="actions">
                  <button className="primary sm" onClick={() => setAdjust({ item: s, mode: 'in' })}>+ Receive</button>
                  <button className="sm" onClick={() => setAdjust({ item: s, mode: 'out' })}>− Issue</button>
                  <button className="sm ghost" onClick={() => setHistory(s)}>History</button>
                  {canEdit && <button className="sm ghost" onClick={() => setEdit(s)}>Edit</button>}
                </td>
              </tr>
            );
          })}</tbody>
        </table></div>
      )}
      {edit && (
        <Modal title={edit.id ? `Edit ${edit.name}` : 'Add stock item'} onClose={() => setEdit(null)}>
          <ActionForm onSubmit={save}>
            <Field label="Name"><input name="name" defaultValue={edit.name} required /></Field>
            <div className="grid3">
              <Field label="Type"><select name="type" defaultValue={edit.type}>{Object.entries(TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
              <Field label="Unit"><input name="unit" defaultValue={edit.unit} required placeholder="kg, packet, litre" /></Field>
              {!edit.id && <Field label="Opening quantity"><input name="quantity" type="number" min="0" step="any" defaultValue={0} /></Field>}
            </div>
            <div className="grid3">
              <Field label="Price per unit (₹)"><input name="price_per_unit" type="number" min="0" step="any" defaultValue={edit.price_per_unit} /></Field>
              <Field label="Reorder level"><input name="reorder_level" type="number" min="0" step="any" defaultValue={edit.reorder_level} /></Field>
            </div>
            <label className="check"><input type="checkbox" name="certified" defaultChecked={!!edit.certified} /> KVK certified</label>
            <label className="check"><input type="checkbox" name="active" defaultChecked={!!edit.active} /> Show to farmers</label>
          </ActionForm>
        </Modal>
      )}
      {adjust && (
        <Modal title={`${adjust.mode === 'in' ? 'Receive' : 'Issue'}: ${adjust.item.name}`} onClose={() => setAdjust(null)}>
          <p className="muted">Current stock: {adjust.item.quantity} {adjust.item.unit}</p>
          <ActionForm onSubmit={doAdjust} submitLabel={adjust.mode === 'in' ? 'Add to stock' : 'Remove from stock'}>
            <Field label={`Quantity (${adjust.item.unit})`}><input name="qty" type="number" min="0.01" step="any" required autoFocus /></Field>
            <Field label="Reason">
              {adjust.mode === 'in'
                ? <select name="reason"><option value="received">Received / produced</option></select>
                : <select name="reason"><option value="sold">Sold to farmer</option><option value="issued">Issued for demo / training</option><option value="damaged">Damaged / expired</option><option value="correction">Stock count correction</option></select>}
            </Field>
            <Field label="Note (optional)"><input name="note" placeholder="e.g. invoice no., farmer name" /></Field>
          </ActionForm>
        </Modal>
      )}
      {history && <HistoryModal item={history} onClose={() => setHistory(null)} />}
    </>
  );
}

function HistoryModal({ item, onClose }) {
  const [rows, err] = useLoad(`/erp/stock/${item.id}/movements`);
  return (
    <Modal title={`Stock history: ${item.name}`} onClose={onClose}>
      <ErrorBox error={err} />
      {!rows ? <Loading /> : !rows.length ? <Empty>No movements yet.</Empty> : (
        <table><thead><tr><th>When</th><th>Change</th><th>Reason</th><th>By</th></tr></thead><tbody>{rows.map((m) => (
          <tr key={m.id}><td className="small">{m.created_at.slice(0, 16)}</td><td className={m.change > 0 ? 'ok' : 'bad'}>{m.change > 0 ? '+' : ''}{m.change} {item.unit}</td><td>{m.reason}{m.note && <div className="muted small">{m.note}</div>}</td><td className="small">{m.user_name}</td></tr>
        ))}</tbody></table>
      )}
    </Modal>
  );
}

// ---------------- Farmers ----------------
export function Farmers({ kvkKey }) {
  const [tab, setTab] = useState('pending');
  const [q, setQ] = useState('');
  const [rows, err, reload] = useLoad(`/erp/farmers?status=${tab}&q=${encodeURIComponent(q)}`, [kvkKey]);
  const [reject, setReject] = useState(null);
  const [rowErr, setRowErr] = useState(null);
  const verify = async (f, decision, note) => {
    await api(`/erp/farmers/${f.id}/verify`, { method: 'POST', body: { decision, note } });
    setReject(null); reload();
  };
  return (
    <>
      <div className="row"><h2>Farmers</h2><input className="search" placeholder="Search name, phone, village" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <Tabs value={tab} onChange={setTab} options={[['pending', 'Needs verification'], ['verified', 'Verified'], ['rejected', 'Rejected'], ['', 'All']]} />
      <ErrorBox error={err || rowErr} />
      {!rows ? <Loading /> : !rows.length ? <Empty>No farmers here.</Empty> : (
        <div className="card flush"><table className="table">
          <thead><tr><th>Farmer</th><th>Village</th><th>ID</th><th className="num">Land</th><th className="num">Bookings</th><th>Status</th><th></th></tr></thead>
          <tbody>{rows.map((f) => (
            <tr key={f.id}>
              <td><b>{f.name || '—'}</b><div className="muted small">{f.phone}</div></td>
              <td>{f.village}</td>
              <td className="small">{f.id_type || 'ID'} ••••{f.id_last4 || '????'}</td>
              <td className="num">{f.land_acres != null ? `${f.land_acres} ac` : '—'}</td>
              <td className="num">{f.bookings}</td>
              <td><Badge s={f.status} />{f.status_note && <div className="muted small">{f.status_note}</div>}</td>
              <td className="actions">
                {f.status !== 'verified' && f.status !== 'new' && <button className="primary sm" onClick={() => verify(f, 'verified').catch((e) => setRowErr(e.message))}>Verify</button>}
                {f.status !== 'rejected' && f.status !== 'new' && <button className="sm" onClick={() => setReject(f)}>{f.status === 'verified' ? 'Revoke' : 'Reject'}</button>}
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      <p className="muted small">Check the farmer's Aadhaar or land record in person before verifying. Only verified farmers can book equipment.</p>
      {reject && (
        <Modal title={`Reject ${reject.name}`} onClose={() => setReject(null)}>
          <ActionForm danger submitLabel="Reject" onSubmit={(f) => verify(reject, 'rejected', f.note)}>
            <Field label="Reason (shown to the farmer)"><textarea name="note" rows={3} required placeholder="e.g. Please visit the KVK with your Aadhaar card" /></Field>
          </ActionForm>
        </Modal>
      )}
    </>
  );
}

// ---------------- KVKs (admin) ----------------
export function Kvks({ onPick }) {
  const [q, setQ] = useState('');
  const [demoMsg, setDemoMsg] = useState(null);
  const [rows, err, reload] = useLoad(`/erp/kvks?q=${encodeURIComponent(q)}`);
  const [edit, setEdit] = useState(null);
  const save = async (f) => {
    const body = { ...f, active: f.active === 'on' };
    if (edit.id) await api(`/erp/kvks/${edit.id}`, { method: 'PUT', body });
    else await api('/erp/kvks', { method: 'POST', body });
    setEdit(null); reload();
  };
  return (
    <>
      <div className="row"><h2>KVKs</h2><input className="search" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
        <button onClick={async () => { setDemoMsg('Loading…'); try { const r = await api('/erp/demo-data', { method: 'POST' }); setDemoMsg(`Added ${r.kvks_created} sample KVKs`); reload(); } catch (e) { setDemoMsg(e.message); } }}>Load sample KVKs</button>
        <button className="primary" onClick={() => setEdit({ active: 1 })}>+ Add KVK</button></div>
      {demoMsg && <p className="muted small">{demoMsg}</p>}
      <ErrorBox error={err} />
      {!rows ? <Loading /> : (
        <div className="card flush"><table className="table">
          <thead><tr><th>Code</th><th>Name</th><th>District, State</th><th>Host institution</th><th className="num">Farmers</th><th className="num">Equipment</th><th></th></tr></thead>
          <tbody>{rows.map((k) => (
            <tr key={k.id} className={k.active ? '' : 'inactive'}>
              <td className="muted">{k.code}</td><td><b>{k.name}</b><div className="muted small">{k.phone}</div></td><td>{k.district}, {k.state}</td>
              <td className="small">{k.host_institution}</td><td className="num">{k.farmers}</td><td className="num">{k.equipment}</td>
              <td className="actions"><button className="primary sm" onClick={() => onPick(k.id)}>Open</button><button className="sm" onClick={() => setEdit(k)}>Edit</button></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {edit && (
        <Modal title={edit.id ? `Edit ${edit.name}` : 'Add KVK'} onClose={() => setEdit(null)}>
          <ActionForm onSubmit={save}>
            <div className="grid3">
              <Field label="Code"><input name="code" defaultValue={edit.code} required placeholder="PB-LDH" /></Field>
              <Field label="State"><input name="state" defaultValue={edit.state} required /></Field>
              <Field label="District"><input name="district" defaultValue={edit.district} required /></Field>
            </div>
            <Field label="Name"><input name="name" defaultValue={edit.name} required /></Field>
            <Field label="Address"><input name="address" defaultValue={edit.address || ''} /></Field>
            <div className="grid3">
              <Field label="Phone"><input name="phone" defaultValue={edit.phone || ''} /></Field>
              <Field label="Host institution"><input name="host_institution" defaultValue={edit.host_institution || ''} /></Field>
            </div>
            <label className="check"><input type="checkbox" name="active" defaultChecked={!!edit.active} /> Active</label>
          </ActionForm>
        </Modal>
      )}
    </>
  );
}

// ---------------- Staff ----------------
export function Staff({ kvkKey, isAdmin }) {
  const [rows, err, reload] = useLoad('/erp/users', [kvkKey]);
  const [adding, setAdding] = useState(false);
  const toggle = async (u) => { await api(`/erp/users/${u.id}`, { method: 'PUT', body: { active: !u.active } }); reload(); };
  return (
    <>
      <div className="row"><h2>Staff accounts</h2><button className="primary" onClick={() => setAdding(true)}>+ Add staff</button></div>
      <ErrorBox error={err} />
      {!rows ? <Loading /> : (
        <div className="card flush"><table className="table">
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th></th></tr></thead>
          <tbody>{rows.map((u) => (
            <tr key={u.id} className={u.active ? '' : 'inactive'}>
              <td>{u.name}</td><td>{u.email}</td><td>{u.role}</td>
              <td className="actions">{(isAdmin || u.role === 'staff') && <button className="sm" onClick={() => toggle(u)}>{u.active ? 'Deactivate' : 'Activate'}</button>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {adding && (
        <Modal title="Add staff account" onClose={() => setAdding(false)}>
          <ActionForm onSubmit={async (f) => { await api('/erp/users', { method: 'POST', body: f }); setAdding(false); reload(); }}>
            <Field label="Name"><input name="name" required /></Field>
            <Field label="Email"><input name="email" type="email" required /></Field>
            <Field label="Temporary password (8+ characters)"><input name="password" type="text" minLength={8} required /></Field>
            <Field label="Role">
              <select name="role" defaultValue="staff">
                <option value="staff">Staff (bookings, stock movements, verification)</option>
                {isAdmin && <option value="manager">KVK manager (also edits catalogue and staff)</option>}
                {isAdmin && <option value="admin">National admin</option>}
              </select>
            </Field>
          </ActionForm>
        </Modal>
      )}
    </>
  );
}

// ---------------- Trainings ----------------
// Staff publish training programmes; farmers see them in the KVK Kisan app, download the
// application form and register in person at the KVK office.
const AUDIENCES = ['Farmers', 'Farm women', 'Rural youth', 'Farmers and rural youth', 'Students', 'Extension workers', 'Anyone interested'];

const readFileBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] || '');
  r.onerror = () => reject(new Error('Could not read the file'));
  r.readAsDataURL(file);
});
const kb = (n) => `${Math.max(1, Math.round(n / 1024))} KB`;

export function Trainings({ kvkKey }) {
  const [when, setWhen] = useState('upcoming');
  const [rows, err, reload] = useLoad(`/erp/trainings?when=${when}`, [kvkKey]);
  const [edit, setEdit] = useState(null);
  const today = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
  const blank = () => ({ category: 'Agriculture', audience: 'Farmers', active: true, documents: DEMO_TRAINING_DOCS, steps: DEMO_TRAINING_STEPS, venue: 'KVK training hall' });
  return (
    <>
      <div className="row"><h2>Trainings</h2><button className="primary" onClick={() => setEdit(blank())}>+ Add training</button></div>
      <p className="muted">Farmers see these in the KVK Kisan app with the timings, how to apply, the documents to bring and the application form to download. Registration happens at the KVK office.</p>
      <Tabs value={when} onChange={setWhen} options={[['upcoming', 'Upcoming and running'], ['past', 'Past']]} />
      <ErrorBox error={err} />
      {!rows ? <Loading /> : !rows.length ? <Empty>{when === 'past' ? 'No past trainings.' : 'No upcoming trainings. Add one so farmers can see it.'}</Empty> : (
        <div className="card flush"><table className="table">
          <thead><tr><th>Training</th><th>Dates and timing</th><th>Apply by</th><th className="num">Seats</th><th>Form</th><th></th></tr></thead>
          <tbody>{rows.map((tr) => (
            <tr key={tr.id} className={tr.active ? '' : 'inactive'}>
              <td><b>{tr.title}</b>{!tr.active && <span className="badge b-cancelled">Hidden</span>}
                <div className="muted small">{tr.category}{tr.audience ? ` · ${tr.audience}` : ''}</div></td>
              <td>{fmtDate(tr.start_date)}{tr.end_date !== tr.start_date ? ` – ${fmtDate(tr.end_date)}` : ''}
                {tr.start_date <= today && tr.end_date >= today && <span className="badge b-issued">Running</span>}
                <div className="muted small">{tr.timing}</div></td>
              <td>{tr.last_date ? <span className={tr.last_date < today ? 'muted' : ''}>{fmtDate(tr.last_date)}</span> : <span className="muted">—</span>}</td>
              <td className="num">{tr.seats ?? '—'}{tr.fee ? <div className="muted small">{inr(tr.fee)}</div> : <div className="muted small">Free</div>}</td>
              <td>{tr.form ? <span className="ok small">✓ {tr.form.url ? 'Link' : kb(tr.form.size || 0)}</span> : <span className="warn small">No form</span>}
                <div className="muted small">{(tr.documents || []).length} documents</div></td>
              <td className="actions"><button className="sm" onClick={() => setEdit(tr)}>Edit</button></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {edit && <TrainingModal training={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </>
  );
}

function TrainingModal({ training: tr, onClose, onSaved }) {
  const [delErr, setDelErr] = useState(null);
  const [sure, setSure] = useState(false);
  const save = async (f) => {
    const body = {
      title: f.title, category: f.category, audience: f.audience, description: f.description,
      start_date: f.start_date, end_date: f.end_date || f.start_date, timing: f.timing, last_date: f.last_date,
      venue: f.venue, seats: f.seats, fee: f.fee, contact: f.contact, documents: f.documents, steps: f.steps,
      active: f.active === 'on',
    };
    const file = f.form_file instanceof File && f.form_file.size ? f.form_file : null;
    if (file) {
      if (file.size > MAX_FORM_BYTES) throw new Error(`The form must be ${kb(MAX_FORM_BYTES)} or smaller (this one is ${kb(file.size)}). Compress the PDF, or paste a link instead.`);
      body.form_file = { name: file.name, type: file.type, data: await readFileBase64(file) };
    } else if (f.form_url?.trim()) {
      body.form_url = f.form_url.trim(); body.form_name = f.form_name;
    } else if (f.remove_form === 'on') body.remove_form = true;
    if (tr.id) await api(`/erp/trainings/${tr.id}`, { method: 'PUT', body });
    else await api('/erp/trainings', { method: 'POST', body });
    onSaved();
  };
  const del = async () => {
    if (!sure) return setSure(true);
    try { await api(`/erp/trainings/${tr.id}`, { method: 'DELETE' }); onSaved(); } catch (e) { setDelErr(e.message); }
  };
  return (
    <Modal title={tr.id ? `Edit training` : 'Add training'} onClose={onClose}>
      <ActionForm onSubmit={save} submitLabel={tr.id ? 'Save training' : 'Publish training'}>
        <Field label="Training title"><input name="title" defaultValue={tr.title || ''} required placeholder="e.g. Mushroom cultivation" /></Field>
        <div className="grid2f">
          <Field label="Category"><select name="category" defaultValue={tr.category}>{TRAINING_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></Field>
          <Field label="Who can apply"><input name="audience" list="audiences" defaultValue={tr.audience || ''} /></Field>
        </div>
        <datalist id="audiences">{AUDIENCES.map((a) => <option key={a} value={a} />)}</datalist>
        <Field label="About the training"><textarea name="description" rows={3} defaultValue={tr.description || ''} placeholder="What farmers will learn, practicals, field visits…" /></Field>
        <div className="grid3">
          <Field label="Starts on"><input name="start_date" type="date" defaultValue={tr.start_date || ''} required /></Field>
          <Field label="Ends on"><input name="end_date" type="date" defaultValue={tr.end_date || ''} /></Field>
          <Field label="Last date to apply"><input name="last_date" type="date" defaultValue={tr.last_date || ''} /></Field>
        </div>
        <div className="grid3">
          <Field label="Daily timing"><input name="timing" defaultValue={tr.timing || ''} placeholder="10:00 AM – 4:00 PM" /></Field>
          <Field label="Seats"><input name="seats" type="number" min="0" step="1" defaultValue={tr.seats ?? ''} /></Field>
          <Field label="Fee (₹, 0 = free)"><input name="fee" type="number" min="0" step="1" defaultValue={tr.fee ?? 0} /></Field>
        </div>
        <div className="grid2f">
          <Field label="Venue"><input name="venue" defaultValue={tr.venue || ''} /></Field>
          <Field label="Contact person / phone"><input name="contact" defaultValue={tr.contact || ''} placeholder="Dr. Kaur, 98xxxxxx10" /></Field>
        </div>
        <Field label="How to apply (one step per line)"><textarea name="steps" rows={5} defaultValue={(tr.steps || []).join('\n')} /></Field>
        <Field label="Documents to bring (one per line)"><textarea name="documents" rows={5} defaultValue={(tr.documents || []).join('\n')} /></Field>
        <fieldset className="formbox">
          <legend>Application form for farmers to download</legend>
          {tr.form && <p className="small">Current: <b>{tr.form.name}</b> {tr.form.url ? '(link)' : `(${kb(tr.form.size || 0)})`}</p>}
          <Field label={`${tr.form ? 'Replace with a file' : 'Upload file'} (PDF, Word or photo, up to ${kb(MAX_FORM_BYTES)})`}>
            <input name="form_file" type="file" accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,application/pdf,image/*" />
          </Field>
          <div className="grid2f">
            <Field label="…or paste a link to the form"><input name="form_url" type="url" placeholder="https://drive.google.com/…" /></Field>
            <Field label="Link name"><input name="form_name" placeholder="Application form (PDF)" /></Field>
          </div>
          {tr.form && <label className="check"><input type="checkbox" name="remove_form" /> Remove the current form</label>}
        </fieldset>
        <label className="check"><input type="checkbox" name="active" defaultChecked={tr.active !== false} /> Show to farmers</label>
      </ActionForm>
      {tr.id && <div className="modal-foot">
        {delErr && <div className="error">{delErr}</div>}
        <button className="danger sm" onClick={del}>{sure ? 'Click again to delete for good' : 'Delete training'}</button>
      </div>}
    </Modal>
  );
}
