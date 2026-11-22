import React, { useEffect, useState } from 'react';
import { onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, sendPasswordResetEmail } from 'firebase/auth';
import { api, setActiveKvk } from './api.js';
import { auth, USE_EMULATOR } from './firebase.js';
import { ActionForm, Field } from './ui.jsx';
import { Dashboard, Bookings, Equipment, Stock, Farmers, Kvks, Staff, Trainings } from './pages.jsx';

const NAV = [
  ['dashboard', 'Dashboard', '▦'],
  ['bookings', 'Bookings', '📅'],
  ['equipment', 'Equipment', '🚜'],
  ['stock', 'Feeds & fertilizers', '🌱'],
  ['trainings', 'Trainings', '🎓'],
  ['farmers', 'Farmers', '👩‍🌾'],
  ['staff', 'Staff', '👥'],
  ['kvks', 'All KVKs', '🗺'],
];

// Shown only until the first national admin has been set up on a fresh project.
function FirstSetup({ onCancel }) {
  return (
    <div className="login">
      <div className="login-card">
        <div className="brand-big">🌾 First-time setup</div>
        <p className="muted">Create the national admin account. This works only once; after that, admins create all other accounts.</p>
        <ActionForm submitLabel="Create admin account" onSubmit={async (f) => {
          if (f.password.length < 8) throw new Error('Password must be at least 8 characters');
          try { await createUserWithEmailAndPassword(auth, f.email.trim(), f.password); }
          catch (e) { if (e.code !== 'auth/email-already-in-use') throw e; await signInWithEmailAndPassword(auth, f.email.trim(), f.password); }
          await api('/setup/claim-admin', { method: 'POST', body: { name: f.name } });
          location.reload();
        }}>
          <Field label="Your name"><input name="name" required /></Field>
          <Field label="Email"><input name="email" type="email" required /></Field>
          <Field label="Password (8+ characters)"><input name="password" type="password" minLength={8} required /></Field>
        </ActionForm>
        <button className="ghost sm link" onClick={onCancel}>Back to sign in</button>
      </div>
    </div>
  );
}

function Login() {
  const [msg, setMsg] = useState(null);
  const [setupOpen, setSetupOpen] = useState(null); // null = unknown, true = setup not done yet
  const [showSetup, setShowSetup] = useState(false);
  useEffect(() => { api('/setup/status').then((r) => setSetupOpen(!r.done)).catch(() => {}); }, []);
  if (showSetup) return <FirstSetup onCancel={() => setShowSetup(false)} />;
  return (
    <div className="login">
      <div className="login-card">
        <div className="brand-big">🌾 KVK ERP</div>
        <p className="muted">Krishi Vigyan Kendra staff sign-in</p>
        <ActionForm submitLabel="Sign in" onSubmit={async (f) => {
          try { await signInWithEmailAndPassword(auth, f.email.trim(), f.password); }
          catch (e) { throw new Error(/invalid|wrong|not-found|credential/.test(e.code || '') ? 'Wrong email or password' : e.message); }
        }}>
          <Field label="Email"><input name="email" type="email" required autoFocus autoComplete="username" /></Field>
          <Field label="Password"><input name="password" type="password" required autoComplete="current-password" /></Field>
        </ActionForm>
        <button className="ghost sm link" onClick={async () => {
          const email = document.querySelector('input[name=email]').value.trim();
          if (!email) return setMsg('Type your email above first.');
          try { await sendPasswordResetEmail(auth, email); setMsg('Password reset email sent.'); } catch (e) { setMsg(e.message); }
        }}>Forgot password?</button>
        {msg && <p className="muted small">{msg}</p>}
        {setupOpen && <div className="setup-note">New installation? <button className="ghost sm link inline" onClick={() => setShowSetup(true)}>Set up the national admin</button></div>}
        {USE_EMULATOR && <details className="demo"><summary>Demo accounts (local emulator)</summary>
          <p>National admin: <code>admin@kvk.in</code> / <code>admin12345</code></p>
          <p>KVK Ludhiana manager: <code>manager.ludhiana@kvk.in</code> / <code>manager123</code></p>
          <p>KVK Ludhiana staff: <code>staff.ludhiana@kvk.in</code> / <code>staff1234</code></p>
        </details>}
      </div>
    </div>
  );
}

const readPage = () => (location.hash.slice(1) || 'dashboard');

export default function App() {
  const [s, setS] = useState(undefined); // undefined = checking, null = signed out
  const [authErr, setAuthErr] = useState(null);
  const [page, setPage] = useState(readPage());
  const [kvks, setKvks] = useState([]);
  const [kvk, setKvk] = useState(() => { try { return localStorage.getItem('kvk-erp-active') || null; } catch { return null; } });
  const [menu, setMenu] = useState(false);

  useEffect(() => onAuthStateChanged(auth, async (u) => {
    if (!u) return setS(null);
    try { setAuthErr(null); setS({ user: await api('/erp/me') }); }
    catch (e) { setAuthErr(e.message); await signOut(auth); }
  }), []);

  const isAdmin = s?.user.role === 'admin';
  const canEdit = s && s.user.role !== 'staff';

  useEffect(() => { const h = () => setPage(readPage()); window.addEventListener('hashchange', h); return () => window.removeEventListener('hashchange', h); }, []);
  useEffect(() => { if (isAdmin) api('/erp/kvks').then(setKvks).catch(() => {}); }, [isAdmin]);

  if (s === undefined) return <div className="login"><div className="login-card">Loading…</div></div>;
  if (!s) return <>{authErr && <div className="error top-error">{authErr}</div>}<Login /></>;

  // Only admins switch KVK; everyone else is fixed to their own.
  const activeKvk = isAdmin ? kvk : s.user.kvk?.id;
  setActiveKvk(isAdmin ? kvk : null);
  const pickKvk = (id) => {
    setKvk(id); setActiveKvk(id);
    try { id ? localStorage.setItem('kvk-erp-active', id) : localStorage.removeItem('kvk-erp-active'); } catch { /* ignore */ }
    go(id ? 'dashboard' : 'kvks');
  };
  const go = (p) => { location.hash = p; setMenu(false); };

  const needsKvk = ['bookings', 'equipment', 'stock', 'trainings', 'farmers'].includes(page) && !activeKvk;
  const nav = NAV.filter(([k]) => (k === 'kvks' ? isAdmin : k === 'staff' ? canEdit : true));
  const props = { go, kvkKey: activeKvk, canEdit, isAdmin };

  return (
    <div className="shell">
      <aside className={menu ? 'side open' : 'side'}>
        <div className="brand">🌾 KVK ERP</div>
        <nav>{nav.map(([k, label, icon]) => (
          <a key={k} href={`#${k}`} className={page === k ? 'active' : ''} onClick={() => setMenu(false)}><span>{icon}</span>{label}</a>
        ))}</nav>
        <div className="side-foot">
          <div>{s.user.name}</div>
          <div className="muted small">{s.user.role === 'admin' ? 'National admin' : `${s.user.role} · ${s.user.kvk?.name}`}</div>
          <button className="ghost sm" onClick={() => signOut(auth)}>Sign out</button>
        </div>
      </aside>
      <main>
        <header className="top">
          <button className="ghost burger" onClick={() => setMenu(!menu)} aria-label="Menu">☰</button>
          {isAdmin ? (
            <select value={kvk || ''} onChange={(e) => pickKvk(e.target.value || null)} className="kvk-pick">
              <option value="">All India (national view)</option>
              {kvks.map((k) => <option key={k.id} value={k.id}>{k.name} · {k.state}</option>)}
            </select>
          ) : <b>{s.user.kvk?.name}</b>}
        </header>
        <div className="content">
          {needsKvk ? <div className="empty">Choose a KVK in the top bar to see this page.</div> : (
            <>
              {page === 'dashboard' && <Dashboard {...props} />}
              {page === 'bookings' && <Bookings {...props} />}
              {page === 'equipment' && <Equipment {...props} />}
              {page === 'stock' && <Stock {...props} />}
              {page === 'trainings' && <Trainings {...props} />}
              {page === 'farmers' && <Farmers {...props} />}
              {page === 'staff' && canEdit && <Staff {...props} />}
              {page === 'kvks' && isAdmin && <Kvks onPick={pickKvk} />}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
