import React, { useCallback, useEffect, useState } from 'react';
import { onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut } from 'firebase/auth';
import { farmerEmail } from '../../../shared/backend.js';
import { auth } from './firebase.js';
import { api, prefs, today, addDays, daysBetween, inr, fmtDate } from './api.js';
import { makeT } from './i18n.js';

const Ctx = React.createContext(null);
const useApp = () => React.useContext(Ctx);

// ---------------- Sign in with mobile number + password ----------------
function Login({ onBrowse }) {
  const { t } = useApp();
  const [mode, setMode] = useState('in'); // 'in' | 'up'
  const [phone, setPhone] = useState('');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const submit = async (e) => {
    e.preventDefault(); setErr(null);
    if (!/^[6-9]\d{9}$/.test(phone)) return setErr(t('badPhone'));
    if (pw.length < 6) return setErr(t('shortPw'));
    setBusy(true);
    try {
      if (mode === 'up') await createUserWithEmailAndPassword(auth, farmerEmail(phone), pw);
      else await signInWithEmailAndPassword(auth, farmerEmail(phone), pw);
    } catch (x) {
      const c = x.code || '';
      setErr(c.includes('email-already-in-use') ? t('exists') : /invalid|wrong|not-found|credential/.test(c) ? t('wrongPw') : c.includes('too-many') ? t('tooMany') : x.message);
    } finally { setBusy(false); }
  };

  return (
    <div className="hero">
      <div className="hero-top"><LangToggle /></div>
      <div className="hero-grid">
      <div className="hero-copy">
        <div className="logo">🌾</div>
        <h1>{t('app')}</h1>
        <p className="tagline">{t('tagline')}</p>
        <ul className="features desk-only">
          <li>🚜 {t('f1')}</li><li>🌱 {t('f2')}</li><li>✅ {t('f3')}</li>
        </ul>
      </div>
      <div className="sheet">
        <div className="seg">
          <button className={mode === 'in' ? 'on' : ''} onClick={() => setMode('in')}>{t('signIn')}</button>
          <button className={mode === 'up' ? 'on' : ''} onClick={() => setMode('up')}>{t('signUp')}</button>
        </div>
        <form onSubmit={submit}>
          <label className="lbl">{t('phone')}</label>
          <div className="phone"><span>+91</span><input inputMode="numeric" autoComplete="username" maxLength={10} value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))} placeholder="98765 43210" autoFocus /></div>
          <label className="lbl">{t('password')}</label>
          <input type="password" autoComplete={mode === 'up' ? 'new-password' : 'current-password'} value={pw} onChange={(e) => setPw(e.target.value)} />
          {mode === 'up' && <div className="hint">{t('signUpHint')}</div>}
          {err && <div className="err">{err}</div>}
          <button className="btn" disabled={busy}>{busy ? '…' : mode === 'up' ? t('signUp') : t('signIn')}</button>
        </form>
        <button className="link" onClick={onBrowse}>{t('browse')}</button>
      </div>
      </div>
    </div>
  );
}

function LangToggle() {
  const { lang, setLang } = useApp();
  return <button className="lang" onClick={() => setLang(lang === 'en' ? 'hi' : 'en')}>{lang === 'en' ? 'हिंदी' : 'English'}</button>;
}

// ---------------- KVK picker ----------------
function KvkPicker({ value, onPick }) {
  const { t } = useApp();
  const [states, setStates] = useState(null);
  const [state, setState] = useState('');
  const [district, setDistrict] = useState('');
  const [kvks, setKvks] = useState([]);
  useEffect(() => { api('/public/states').then(setStates).catch(() => setStates([])); }, []);
  useEffect(() => {
    if (!state) return setKvks([]);
    api(`/public/kvks?state=${encodeURIComponent(state)}${district ? `&district=${encodeURIComponent(district)}` : ''}`).then(setKvks).catch(() => {});
  }, [state, district]);
  const districts = states?.find((s) => s.state === state)?.districts || [];
  return (
    <div className="picker">
      <label className="lbl">{t('state')}</label>
      <select value={state} onChange={(e) => { setState(e.target.value); setDistrict(''); }}>
        <option value="">{t('choose')}</option>
        {states?.map((s) => <option key={s.state}>{s.state}</option>)}
      </select>
      {state && <>
        <label className="lbl">{t('district')}</label>
        <select value={district} onChange={(e) => setDistrict(e.target.value)}>
          <option value="">{t('choose')}</option>
          {districts.map((d) => <option key={d.district}>{d.district}</option>)}
        </select>
      </>}
      {kvks.length > 0 && <>
        <label className="lbl">{t('chooseKvk')}</label>
        <div className="kvk-list">{kvks.map((k) => (
          <button key={k.id} className={`kvk-item ${value === k.id ? 'sel' : ''}`} onClick={() => onPick(k)} type="button">
            <b>{k.name}</b><span>{k.address}</span>
          </button>
        ))}</div>
      </>}
    </div>
  );
}

// ---------------- Machines tab ----------------
function Machines({ kvkId, onBook }) {
  const { t, lang, farmer } = useApp();
  const [start, setStart] = useState(today());
  const [end, setEnd] = useState(today());
  const [data, setData] = useState(null);
  const [onlyFree, setOnlyFree] = useState(false);
  const [err, setErr] = useState(null);
  const load = useCallback(() => {
    setErr(null);
    // Always fetch at least a week so farmers can see the coming days at a glance
    const to = end > addDays(start, 6) ? end : addDays(start, 6);
    api(`/public/kvks/${kvkId}/availability?start=${start}&end=${to}`).then(setData).catch((e) => setErr(e.message));
  }, [kvkId, start, end]);
  useEffect(load, [load]);

  // Free units across the chosen dates only
  const items = (data?.equipment || [])
    .map((e) => ({ ...e, min_available: Math.min(...e.days.filter((d) => d.date >= start && d.date <= end).map((d) => d.available)) }))
    .filter((e) => !onlyFree || e.min_available > 0);
  return (
    <>
      <div className="toolbar"><div className="dates">
        <label>{t('from')}<input type="date" value={start} min={today()} max={addDays(today(), 90)} onChange={(e) => { setStart(e.target.value); if (e.target.value > end) setEnd(e.target.value); }} /></label>
        <label>{t('to')}<input type="date" value={end} min={start} max={addDays(start, 30)} onChange={(e) => setEnd(e.target.value)} /></label>
      </div>
      <div className="chips">
        <button className={!onlyFree ? 'chip on' : 'chip'} onClick={() => setOnlyFree(false)}>{t('allMachines')}</button>
        <button className={onlyFree ? 'chip on' : 'chip'} onClick={() => setOnlyFree(true)}>{t('availableOnly')}</button>
      </div></div>
      {err && <div className="err">{err === 'offline' ? t('offline') : err}</div>}
      {!data ? <div className="muted">…</div> : <div className="grid-cards">{items.map((e) => {
        const days = daysBetween(start, end);
        const tooLong = days > e.max_days;
        return (
          <div key={e.id} className={`card machine ${e.min_available ? '' : 'dim'}`}>
            <div className="m-head">
              <div><b>{e.name}</b><div className="muted small">{e.category}</div></div>
              <div className="price">{e.daily_rate ? inr(e.daily_rate) : 'Free'}<span>{e.daily_rate ? t('perDay') : ''}</span></div>
            </div>
            <div className="strip">{e.days.map((d) => (
              <div key={d.date} className={`d ${d.available ? 'ok' : 'no'} ${d.date >= start && d.date <= end ? 'pick' : ''}`} title={`${d.date}: ${d.available}`}>
                <small>{new Date(d.date + 'T00:00:00').toLocaleDateString(lang === 'hi' ? 'hi-IN' : 'en-IN', { weekday: 'narrow' })}</small>
                <span>{fmtDate(d.date, lang).split(' ')[0]}</span>
              </div>
            ))}</div>
            <div className="m-foot">
              <span className={e.min_available ? 'ok' : 'no'}>{e.min_available ? `${e.min_available} ${t('of')} ${e.total_qty} ${t('free')}` : t('notFree')}</span>
              {tooLong ? <span className="muted small">{t('maxDays', { n: e.max_days })}</span> : (
                <button className="btn sm" disabled={!e.min_available} onClick={() => onBook(e, start, end)}>
                  {!farmer ? t('signInToBook') : t('book')}
                </button>
              )}
            </div>
          </div>
        );
      })}</div>}
    </>
  );
}

function BookSheet({ item, start, end, onClose, onDone }) {
  const { t, lang } = useApp();
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const days = daysBetween(start, end);
  const submit = async () => {
    setBusy(true); setErr(null);
    try { await api('/farmer/bookings', { method: 'POST', body: { equipment_id: item.id, qty, start_date: start, end_date: end, note } }); onDone(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bottom-sheet">
        <h3>{item.name}</h3>
        <p className="muted">{fmtDate(start, lang)} – {fmtDate(end, lang)} · {days} {t('days')}</p>
        {item.min_available > 1 && (
          <div className="qty"><span>{t('qty')}</span>
            <button onClick={() => setQty(Math.max(1, qty - 1))}>−</button><b>{qty}</b><button onClick={() => setQty(Math.min(item.min_available, qty + 1))}>+</button>
          </div>
        )}
        <textarea placeholder={t('note')} value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
        <div className="total"><span>{t('total')}</span><b>{inr(item.daily_rate * qty * days)}</b></div>
        {err && <div className="err">{err}</div>}
        <button className="btn" onClick={submit} disabled={busy}>{busy ? '…' : t('bookNow')}</button>
      </div>
    </div>
  );
}

// ---------------- Stock tab ----------------
function StockTab({ kvk }) {
  const { t } = useApp();
  const groups = ['feed', 'fertilizer', 'seed', 'other'].map((g) => [g, kvk.stock.filter((s) => s.type === g)]).filter(([, l]) => l.length);
  return (
    <>
      <p className="muted small">{t('buyAtKvk')}</p>
      <div className="stock-grid">{groups.map(([g, list]) => (
        <div key={g} className="card">
          <h3>{t(g)}</h3>
          {list.map((s) => (
            <div key={s.id} className="stock-row">
              <div><b>{s.name}</b>{s.certified && <span className="cert">✓ {t('certified')}</span>}<div className="muted small">{inr(s.price_per_unit)} / {s.unit}</div></div>
              <span className={`lvl ${s.level}`}>{t(s.level === 'in' ? 'inStock' : s.level)}</span>
            </div>
          ))}
        </div>
      ))}</div>
    </>
  );
}

// ---------------- Bookings tab ----------------
function BookingsTab() {
  const { t, lang } = useApp();
  const [rows, setRows] = useState(null);
  const load = () => api('/farmer/bookings').then(setRows).catch(() => setRows([]));
  useEffect(() => { load(); }, []);
  if (!rows) return <div className="muted">…</div>;
  if (!rows.length) return <div className="empty">{t('noBookings')}</div>;
  return <div className="grid-cards">{rows.map((b) => (
    <div key={b.id} className={`card booking st-${b.status}`}>
      <div className="m-head"><b>{b.equipment_name}{b.qty > 1 ? ` ×${b.qty}` : ''}</b><span className="muted small">#{b.ref}</span></div>
      <div>{fmtDate(b.start_date, lang)} – {fmtDate(b.end_date, lang)} · {inr(b.amount)}</div>
      <div className={`status s-${b.status}`}>{t(`st_${b.status}`)}</div>
      {b.staff_note && <div className="muted small">KVK: {b.staff_note}</div>}
      {b.status === 'requested' && (
        <button className="link danger" onClick={async () => { await api(`/farmer/bookings/${b.id}/cancel`, { method: 'POST' }); load(); }}>{t('cancel')}</button>
      )}
    </div>
  ))}</div>;
}

// ---------------- Profile ----------------
function Profile({ onSaved }) {
  const { t, farmer } = useApp();
  const [kvk, setKvk] = useState(farmer.kvk_id ? { id: farmer.kvk_id, name: farmer.kvk_name } : null);
  const [changing, setChanging] = useState(!farmer.kvk_id);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const submit = async (e) => {
    e.preventDefault(); setErr(null); setBusy(true);
    const f = Object.fromEntries(new FormData(e.currentTarget));
    try { onSaved(await api('/farmer/me', { method: 'PUT', body: { ...f, kvk_id: kvk?.id, land_acres: f.land_acres === '' ? null : f.land_acres } })); }
    catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  return (
    <form className="card profile" onSubmit={submit}>
      <StatusBanner />
      <label className="lbl">{t('name')}</label><input name="name" defaultValue={farmer.name || ''} required />
      <label className="lbl">{t('village')}</label><input name="village" defaultValue={farmer.village || ''} required />
      <label className="lbl">{t('yourKvk')}</label>
      {kvk && !changing ? <div className="kvk-chosen"><b>{kvk.name}</b><button type="button" className="link" onClick={() => setChanging(true)}>{t('change')}</button></div>
        : <KvkPicker value={kvk?.id} onPick={(k) => { setKvk(k); setChanging(false); }} />}
      <div className="two">
        <div><label className="lbl">{t('idType')}</label>
          <select name="id_type" defaultValue={farmer.id_type || 'Aadhaar'}><option>Aadhaar</option><option>Kisan Credit Card</option><option>Voter ID</option><option>Land record</option></select></div>
        <div><label className="lbl">{t('idLast4')}</label><input name="id_last4" inputMode="numeric" maxLength={4} pattern="\d{4}" defaultValue={farmer.id_last4 || ''} /></div>
      </div>
      <label className="lbl">{t('land')}</label><input name="land_acres" type="number" step="0.1" min="0" defaultValue={farmer.land_acres ?? ''} />
      {err && <div className="err">{err}</div>}
      <button className="btn" disabled={busy || !kvk}>{farmer.status === 'verified' ? t('save') : t('submitForVerify')}</button>
      <button type="button" className="link" onClick={() => signOut(auth)}>{t('signOut')} ({farmer.phone})</button>
    </form>
  );
}

function StatusBanner() {
  const { t, farmer } = useApp();
  if (!farmer) return null;
  return (
    <div className={`banner b-${farmer.status}`}>
      {t(`s_${farmer.status}`)}
      {farmer.status === 'rejected' && farmer.status_note && <div className="small">{farmer.status_note}</div>}
    </div>
  );
}

// ---------------- App shell ----------------
export default function App() {
  const [lang, setLangState] = useState(prefs.get('lang', 'en'));
  const setLang = (l) => { setLangState(l); prefs.set('lang', l); document.documentElement.lang = l; };
  const t = makeT(lang);
  const [user, setUser] = useState(undefined);
  const [farmer, setFarmer] = useState(null);
  const [browsing, setBrowsing] = useState(false);
  const [browseKvk, setBrowseKvk] = useState(prefs.get('browseKvk', null));
  const [tab, setTab] = useState('machines');
  const [kvk, setKvk] = useState(null);
  const [booking, setBooking] = useState(null);
  const [toast, setToast] = useState(null);

  useEffect(() => onAuthStateChanged(auth, async (u) => {
    setUser(u);
    if (!u) return setFarmer(null);
    try { setFarmer(await api('/farmer/me')); } catch { setFarmer(null); }
  }), []);

  const kvkId = farmer?.kvk_id || browseKvk?.id;
  useEffect(() => { if (kvkId) api(`/public/kvks/${kvkId}`).then(setKvk).catch(() => {}); else setKvk(null); }, [kvkId]);
  useEffect(() => { if (farmer && !farmer.kvk_id) setTab('profile'); }, [farmer]);

  const ctx = { t, lang, setLang, farmer };
  if (user === undefined) return <div className="splash">🌾</div>;
  if (!user && !browsing) return <Ctx.Provider value={ctx}><Login onBrowse={() => setBrowsing(true)} /></Ctx.Provider>;
  if (user && !farmer) return <div className="splash">🌾</div>;

  const startBooking = (item, start, end) => {
    if (!farmer) { setBrowsing(false); return; }
    if (farmer.status !== 'verified') { setToast(t('verifyFirst')); setTab('profile'); return; }
    setBooking({ item, start, end });
  };

  const tabs = farmer ? [['machines', '🚜', t('equipment')], ['stock', '🌱', t('stock')], ['bookings', '📋', t('bookings')], ['profile', '👤', t('profile')]]
    : [['machines', '🚜', t('equipment')], ['stock', '🌱', t('stock')]];

  return (
    <Ctx.Provider value={ctx}>
      <div className="app">
        <header className="bar">
          <div className="bar-inner">
            <div className="brand-block">
              <span className="brand-logo">🌾</span>
              <div><div className="bar-title">{kvk?.name || t('app')}</div>{kvk && <div className="bar-sub">{kvk.district}, {kvk.state}</div>}</div>
            </div>
            {/* Laptop/desktop: navigation lives in the header */}
            <nav className="topnav">{tabs.map(([k, icon, label]) => (
              <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}><span>{icon}</span>{label}</button>
            ))}</nav>
            <div className="bar-actions">
              {kvk?.phone && <a className="call" href={`tel:${kvk.phone}`}>📞 <span className="call-label">{t('call')}</span></a>}
              <LangToggle />
              {farmer ? <button className="lang desk-only" onClick={() => signOut(auth)}>{t('signOut')}</button>
                : <button className="lang desk-only" onClick={() => setBrowsing(false)}>{t('signIn')}</button>}
            </div>
          </div>
        </header>
        {kvk && (
          <section className="kvk-hero desk-only">
            <div className="kvk-hero-inner">
              <div><h1>{kvk.name}</h1><p>{kvk.address}{kvk.host_institution ? ` · ${kvk.host_institution}` : ''}</p></div>
              <div className="hero-stats">
                <div><b>{kvk.equipment.length}</b><span>{t('equipment')}</span></div>
                <div><b>{kvk.stock.filter((x) => x.level !== 'out').length}</b><span>{t('inStock')}</span></div>
                {farmer && <div><b className={`st st-${farmer.status}`}>{t(`s_${farmer.status}`).split('.')[0]}</b><span>{t('profile')}</span></div>}
              </div>
            </div>
          </section>
        )}
        <main className={`body tab-${tab}`}>
          {farmer && farmer.status !== 'verified' && tab !== 'profile' && <div onClick={() => setTab('profile')}><StatusBanner /></div>}
          {!kvkId && !farmer ? (
            <div className="card"><h3>{t('findKvk')}</h3><KvkPicker onPick={(k) => { setBrowseKvk(k); prefs.set('browseKvk', k); }} /></div>
          ) : tab === 'profile' && farmer ? <Profile onSaved={(f) => { setFarmer(f); setTab('machines'); }} />
            : !kvkId ? null
            : tab === 'machines' ? <>
                {!farmer && <button className="link" onClick={() => { setBrowseKvk(null); prefs.set('browseKvk', null); }}>{t('findKvk')}: {t('change')}</button>}
                <Machines kvkId={kvkId} onBook={startBooking} />
              </>
            : tab === 'stock' ? (kvk ? <StockTab kvk={kvk} /> : null)
            : tab === 'bookings' ? <BookingsTab /> : null}
        </main>
        <nav className="tabbar">{tabs.map(([k, icon, label]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}><span>{icon}</span>{label}</button>
        ))}</nav>
        {booking && <BookSheet {...booking} onClose={() => setBooking(null)} onDone={() => { setBooking(null); setToast(t('requested')); setTab('bookings'); }} />}
        {toast && <div className="toast" onAnimationEnd={() => setToast(null)}>{toast}</div>}
        <footer className="site-foot desk-only">🌾 {t('app')} · {t('tagline')}</footer>
      </div>
    </Ctx.Provider>
  );
}
