// Client-side "API" for the Spark (free) plan: both apps talk to Firestore directly.
// Security rules (firestore.rules) enforce roles and KVK scoping; capacity checks run in
// Firestore transactions on the equipment document, which holds the approved/issued "holds".
//
// Usage: const api = createBackend(firebaseApp); await api('/erp/bookings?status=active')
import {
  getFirestore, collection, doc, getDoc, getDocs, query, where, setDoc, updateDoc, runTransaction,
  writeBatch, getCountFromServer, deleteField, increment,
} from 'firebase/firestore';
import { getAuth, initializeAuth, inMemoryPersistence, createUserWithEmailAndPassword, signOut, connectAuthEmulator } from 'firebase/auth';

let secondaryAuth = null;
import { initializeApp, getApps } from 'firebase/app';

// Farmers sign in with mobile number + password. Firebase Auth needs an email, so the
// mobile number is mapped to <number>@farmer.kvk.in behind the scenes.
export const FARMER_DOMAIN = 'farmer.kvk.in';
export const farmerEmail = (phone) => `${String(phone).replace(/\D/g, '').slice(-10)}@${FARMER_DOMAIN}`;
const phoneOf = (u) => (u.phoneNumber ? u.phoneNumber.replace(/^\+91/, '')
  : (u.email || '').endsWith('@' + FARMER_DOMAIN) ? u.email.split('@')[0] : null);

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new ApiError(400, m);
const notFound = (m = 'Not found') => new ApiError(404, m);
const forbidden = (m = 'Not allowed') => new ApiError(403, m);

// ---------- date helpers (KVKs run on Indian time) ----------
export const todayIST = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
export function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export const daysInclusive = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000) + 1;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function parseDate(s, field) {
  if (typeof s !== 'string' || !DATE_RE.test(s) || Number.isNaN(Date.parse(s + 'T00:00:00Z'))) throw bad(`${field} must be a date like 2026-12-01`);
  return s;
}
const now = () => new Date().toISOString();

// ---------- capacity from equipment.holds ----------
// holds = { [bookingId]: { qty, s: 'YYYY-MM-DD', e: 'YYYY-MM-DD' } } for approved/issued bookings
export function usage(equipment, start, end, excludeId = null) {
  const holds = Object.entries(equipment.holds || {}).filter(([id]) => id !== excludeId).map(([, h]) => h);
  const out = [];
  for (let i = 0; i < daysInclusive(start, end); i++) {
    const day = addDays(start, i);
    let used = 0;
    for (const h of holds) if (h.s <= day && h.e >= day) used += h.qty;
    out.push({ date: day, used, available: Math.max(0, equipment.total_qty - used) });
  }
  return out;
}
const minAvail = (e, s, en, ex) => Math.min(...usage(e, s, en, ex).map((d) => d.available));
/** Field updates that drop holds which ended before today (keeps the equipment doc small). */
function pruneHolds(e) {
  const today = todayIST();
  return Object.fromEntries(Object.entries(e.holds || {}).filter(([, h]) => h.e < today).map(([id]) => [`holds.${id}`, deleteField()]));
}

const NUMERIC = new Set(['daily_rate', 'total_qty', 'max_days', 'price_per_unit', 'reorder_level', 'quantity', 'land_acres']);
const BOOL = new Set(['active', 'certified']);
const pick = (body, fields) => Object.fromEntries(fields.filter((f) => body && f in body && body[f] !== undefined).map((f) => [f, body[f]]));
const clean = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, NUMERIC.has(k) ? Number(v) : BOOL.has(k) ? (v === true || v === 'on' || v === 1) : v]));
function numOk(v, name, { int = false, min = 0 } = {}) {
  if (v === undefined) return;
  const n = Number(v);
  if (v === '' || Number.isNaN(n) || n < min || (int && !Number.isInteger(n))) throw bad(`${name} must be ${int ? 'a whole number' : 'a number'} of at least ${min}`);
}
const EQUIP_FIELDS = ['name', 'category', 'description', 'daily_rate', 'total_qty', 'max_days', 'active'];
const STOCK_FIELDS = ['type', 'name', 'unit', 'price_per_unit', 'reorder_level', 'certified', 'active'];
const KVK_FIELDS = ['code', 'name', 'state', 'district', 'address', 'phone', 'host_institution', 'active'];
const PROFILE_FIELDS = ['name', 'village', 'district', 'state', 'kvk_id', 'id_type', 'id_last4', 'land_acres'];
const byCatName = (a, b) => (a.category || a.type || '').localeCompare(b.category || b.type || '') || a.name.localeCompare(b.name);
const stockLevel = (s) => (s.quantity <= 0 ? 'out' : s.quantity <= s.reorder_level ? 'low' : 'in');

/** Firestore permission errors become friendly 403s. */
function friendly(e) {
  if (e instanceof ApiError) return e;
  if (e?.code === 'permission-denied') return forbidden('You do not have permission to do that');
  if (e?.code === 'unavailable') return new ApiError(503, 'offline');
  return e;
}

export function createBackend(app) {
  const db = getFirestore(app);
  const auth = getAuth(app);
  const C = (name) => collection(db, name);
  const D = (name, id) => doc(db, name, String(id));
  const one = async (name, id) => { const s = await getDoc(D(name, id)); return s.exists() ? { id: s.id, ...s.data() } : null; };
  const list = async (q) => (await getDocs(q)).docs.map((d) => ({ id: d.id, ...d.data() }));
  const count = async (q) => (await getCountFromServer(q)).data().count;
  const txGet = async (t, name, id) => { const s = await t.get(D(name, id)); return s.exists() ? { id: s.id, ...s.data() } : null; };

  let activeKvk = null; // national admins pick a KVK
  let staffCache = null;

  const user = () => {
    if (!auth.currentUser) throw new ApiError(401, 'Please sign in');
    return auth.currentUser;
  };
  async function staffMe() {
    const u = user();
    if (staffCache?.id === u.uid) return staffCache;
    const s = await one('staff', u.uid);
    if (!s || !s.active) throw forbidden('This account is not an active KVK staff account');
    staffCache = s;
    return s;
  }
  const isAdmin = (s) => s.role === 'admin';
  const managerUp = (s) => { if (s.role === 'staff') throw forbidden('Only KVK managers can do this'); };
  const kvkOf = (s, required = true) => {
    if (!isAdmin(s)) return s.kvk_id;
    if (!activeKvk && required) throw bad('Choose a KVK first');
    return activeKvk || null;
  };
  const owned = (s, row) => {
    if (!row) throw notFound();
    if (row.kvk_id !== kvkOf(s)) throw forbidden('That belongs to another KVK');
    return row;
  };
  function farmerUid() {
    const u = user();
    if (!phoneOf(u)) throw forbidden('Please sign in with your mobile number');
    return u;
  }

  // ======================= PUBLIC =======================
  async function activeKvks() {
    return (await list(query(C('kvks'), where('active', '==', true))))
      .map(({ id, code, name, state, district, address, phone }) => ({ id, code, name, state, district, address, phone }))
      .sort((a, b) => a.state.localeCompare(b.state) || a.district.localeCompare(b.district) || a.name.localeCompare(b.name));
  }

  const routes = [];
  const route = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });

  route('GET', '/public/states', async () => {
    const states = {};
    for (const k of await activeKvks()) { const d = (states[k.state] ??= {}); d[k.district] = (d[k.district] || 0) + 1; }
    return Object.entries(states).map(([state, d]) => ({ state, districts: Object.entries(d).map(([district, kvks]) => ({ district, kvks })) }));
  });

  route('GET', '/public/kvks', async ({ q }) => {
    const text = String(q.q || '').toLowerCase();
    return (await activeKvks()).filter((k) => (!q.state || k.state === q.state) && (!q.district || k.district === q.district) &&
      (!text || `${k.name} ${k.district} ${k.code}`.toLowerCase().includes(text))).slice(0, 200);
  });

  route('GET', '/public/kvks/:id', async ({ p }) => {
    const kvk = await one('kvks', p.id);
    if (!kvk || !kvk.active) throw notFound('KVK not found');
    const [eq, st] = await Promise.all([
      list(query(C('equipment'), where('kvk_id', '==', kvk.id), where('active', '==', true))),
      list(query(C('stock_items'), where('kvk_id', '==', kvk.id), where('active', '==', true))),
    ]);
    return {
      ...kvk,
      equipment: eq.sort(byCatName).map(({ holds, ...e }) => e),
      stock: st.sort(byCatName).map((s) => ({ ...s, level: stockLevel(s) })),
    };
  });

  route('GET', '/public/kvks/:id/availability', async ({ p, q }) => {
    const start = q.start ? parseDate(q.start, 'start') : todayIST();
    const end = q.end ? parseDate(q.end, 'end') : addDays(start, 6);
    if (end < start) throw bad('end must be on or after start');
    if (daysInclusive(start, end) > 62) throw bad('Pick a range of 62 days or fewer');
    const items = (await list(query(C('equipment'), where('kvk_id', '==', p.id), where('active', '==', true)))).sort(byCatName);
    return {
      start, end,
      equipment: items.map((e) => {
        const days = usage(e, start, end).map(({ date, available }) => ({ date, available }));
        return { id: e.id, name: e.name, category: e.category, daily_rate: e.daily_rate, total_qty: e.total_qty, max_days: e.max_days, min_available: Math.min(...days.map((d) => d.available)), days };
      }),
    };
  });

  // ======================= FARMER =======================
  async function farmerMe() {
    const u = farmerUid();
    let f = await one('farmers', u.uid);
    if (!f) {
      f = { phone: phoneOf(u), status: 'new', kvk_id: null, created_at: now() };
      await setDoc(D('farmers', u.uid), f);
      f = { id: u.uid, ...f };
    }
    if (f.kvk_id) {
      const k = await one('kvks', f.kvk_id);
      if (k) Object.assign(f, { kvk_name: k.name, kvk_district: k.district, kvk_phone: k.phone });
    }
    return f;
  }

  route('GET', '/farmer/me', () => farmerMe());

  route('PUT', '/farmer/me', async ({ body }) => {
    const cur = await farmerMe();
    const next = { ...cur };
    for (const k of PROFILE_FIELDS) if (body && k in body) next[k] = body[k] === '' ? null : body[k];
    if (!next.name || String(next.name).trim().length < 2) throw bad('Please enter your name');
    if (!next.village) throw bad('Please enter your village');
    if (!next.kvk_id) throw bad('Please choose your KVK');
    const kvk = await one('kvks', next.kvk_id);
    if (!kvk || !kvk.active) throw bad('That KVK does not exist');
    if (next.id_last4 && !/^\d{4}$/.test(String(next.id_last4))) throw bad('ID last 4 digits must be 4 numbers');
    if (next.land_acres != null && (Number.isNaN(Number(next.land_acres)) || Number(next.land_acres) < 0)) throw bad('Land must be a number');
    const identityChanged = ['name', 'kvk_id', 'id_last4'].some((k) => String(cur[k] ?? '') !== String(next[k] ?? ''));
    let status = cur.status;
    if (status === 'new' || status === 'rejected' || (status === 'verified' && identityChanged)) status = 'pending';
    await updateDoc(D('farmers', cur.id), {
      name: String(next.name).trim(), village: next.village, district: next.district ?? kvk.district, state: next.state ?? kvk.state,
      kvk_id: kvk.id, id_type: next.id_type ?? null, id_last4: next.id_last4 ? String(next.id_last4) : null,
      land_acres: next.land_acres == null ? null : Number(next.land_acres), status,
      ...(status !== cur.status ? { status_note: null, submitted_at: now() } : {}),
    });
    return farmerMe();
  });

  route('GET', '/farmer/bookings', async () => {
    const u = farmerUid();
    return (await list(query(C('bookings'), where('farmer_id', '==', u.uid))))
      .sort((a, b) => b.start_date.localeCompare(a.start_date) || b.created_at.localeCompare(a.created_at));
  });

  route('POST', '/farmer/bookings', async ({ body }) => {
    const f = await farmerMe();
    if (f.status !== 'verified') throw forbidden('Your KVK needs to verify your account before you can book');
    const qty = Number(body?.qty ?? 1);
    if (!Number.isInteger(qty) || qty < 1) throw bad('Quantity must be 1 or more');
    const start = parseDate(body?.start_date, 'start_date');
    const end = parseDate(body?.end_date, 'end_date');
    const today = todayIST();
    if (start < today) throw bad('Start date cannot be in the past');
    if (end < start) throw bad('End date must be on or after start date');
    if (start > addDays(today, 90)) throw bad('Bookings open up to 90 days ahead');
    if (!body?.equipment_id) throw bad('Choose a machine');
    const mine = await list(query(C('bookings'), where('farmer_id', '==', f.id), where('equipment_id', '==', String(body.equipment_id))));
    if (mine.some((b) => ['requested', 'approved', 'issued'].includes(b.status) && b.start_date <= end && b.end_date >= start)) {
      throw bad('You already have a booking for this item on these dates');
    }
    const ref = doc(C('bookings'));
    return runTransaction(db, async (t) => {
      const e = await txGet(t, 'equipment', body.equipment_id);
      if (!e || !e.active) throw notFound('Equipment not found');
      if (e.kvk_id !== f.kvk_id) throw forbidden('You can only book from your own KVK');
      const days = daysInclusive(start, end);
      if (days > e.max_days) throw bad(`${e.name} can be rented for at most ${e.max_days} days`);
      const avail = minAvail(e, start, end);
      if (avail < qty) throw bad(avail === 0 ? 'Not available on these dates' : `Only ${avail} available on these dates`);
      const b = {
        ref: ref.id.slice(0, 6).toUpperCase(), kvk_id: e.kvk_id, farmer_id: f.id, equipment_id: e.id, qty,
        start_date: start, end_date: end, status: 'requested', amount: e.daily_rate * qty * days,
        farmer_note: body.note || null, staff_note: null,
        equipment_name: e.name, category: e.category, kvk_name: f.kvk_name || null,
        farmer_name: f.name, phone: f.phone, village: f.village, created_at: now(),
      };
      t.set(ref, b);
      return { id: ref.id, ...b };
    });
  });

  route('POST', '/farmer/bookings/:id/cancel', async ({ p }) => {
    const u = farmerUid();
    const b = await one('bookings', p.id);
    if (!b || b.farmer_id !== u.uid) throw notFound('Booking not found');
    if (b.status !== 'requested') throw bad('Approved bookings can only be cancelled by calling your KVK');
    await updateDoc(D('bookings', b.id), { status: 'cancelled', cancelled_at: now() });
    return { ...b, status: 'cancelled' };
  });

  // ======================= ERP =======================
  route('GET', '/erp/me', async () => {
    const s = await staffMe();
    const kvk = s.kvk_id ? await one('kvks', s.kvk_id) : null;
    return { id: s.id, name: s.name, email: s.email, role: s.role, kvk: kvk && { id: kvk.id, name: kvk.name, code: kvk.code, state: kvk.state, district: kvk.district } };
  });

  route('GET', '/erp/dashboard', async () => {
    const s = await staffMe();
    const kvk = kvkOf(s, false);
    const today = todayIST();
    const monthStart = today.slice(0, 8) + '01';
    const B = C('bookings'), F = C('farmers');
    if (!kvk) {
      const kvks = await list(query(C('kvks'), where('active', '==', true)));
      const byState = {};
      for (const k of kvks) byState[k.state] = (byState[k.state] || 0) + 1;
      const [fv, fp, br, issued, done] = await Promise.all([
        count(query(F, where('status', '==', 'verified'))), count(query(F, where('status', '==', 'pending'))),
        count(query(B, where('status', '==', 'requested'))), list(query(B, where('status', '==', 'issued'))),
        list(query(B, where('status', 'in', ['issued', 'returned']), where('start_date', '>=', monthStart))),
      ]);
      return {
        scope: 'national', kvks: kvks.length, farmers_verified: fv, farmers_pending: fp, bookings_requested: br,
        equipment_out: issued.reduce((n, b) => n + b.qty, 0), revenue_month: done.reduce((n, b) => n + b.amount, 0),
        by_state: Object.entries(byState).map(([state, n]) => ({ state, kvks: n })).sort((a, b) => b.kvks - a.kvks),
      };
    }
    const [k, fv, fp, act, stock, monthDone] = await Promise.all([
      one('kvks', kvk),
      count(query(F, where('kvk_id', '==', kvk), where('status', '==', 'verified'))),
      count(query(F, where('kvk_id', '==', kvk), where('status', '==', 'pending'))),
      list(query(B, where('kvk_id', '==', kvk), where('status', 'in', ['requested', 'approved', 'issued']))),
      list(query(C('stock_items'), where('kvk_id', '==', kvk), where('active', '==', true))),
      list(query(B, where('kvk_id', '==', kvk), where('status', 'in', ['issued', 'returned']), where('start_date', '>=', monthStart))),
    ]);
    const mini = ({ id, ref, qty, start_date, end_date, equipment_name, farmer_name, phone }) => ({ id, ref, qty, start_date, end_date, equipment_name, farmer_name, phone });
    return {
      scope: 'kvk', kvk: { id: k.id, name: k.name, code: k.code, state: k.state, district: k.district },
      farmers_verified: fv, farmers_pending: fp,
      bookings_requested: act.filter((b) => b.status === 'requested').length,
      equipment_out: act.filter((b) => b.status === 'issued').reduce((n, b) => n + b.qty, 0),
      overdue: act.filter((b) => b.status === 'issued' && b.end_date < today).length,
      revenue_month: monthDone.reduce((n, b) => n + b.amount, 0),
      low_stock: stock.filter((x) => x.quantity <= x.reorder_level).sort((a, b) => a.quantity - b.quantity),
      today_pickups: act.filter((b) => b.status === 'approved' && b.start_date <= today).sort((a, b) => a.start_date.localeCompare(b.start_date)).map(mini),
      today_returns: act.filter((b) => b.status === 'issued' && b.end_date <= today).sort((a, b) => a.end_date.localeCompare(b.end_date)).map(mini),
    };
  });

  // ---- KVKs ----
  route('GET', '/erp/kvks', async ({ q }) => {
    const s = await staffMe();
    if (!isAdmin(s)) return [await one('kvks', s.kvk_id)];
    const text = String(q.q || '').toLowerCase();
    return (await list(C('kvks')))
      .filter((k) => !text || `${k.name} ${k.district} ${k.state} ${k.code}`.toLowerCase().includes(text))
      .sort((a, b) => a.state.localeCompare(b.state) || a.district.localeCompare(b.district) || a.name.localeCompare(b.name));
  });

  route('POST', '/erp/kvks', async ({ body }) => {
    const s = await staffMe();
    if (!isAdmin(s)) throw forbidden('Only national admins can do this');
    const b = clean(pick(body, KVK_FIELDS));
    for (const f of ['code', 'name', 'state', 'district']) if (!b[f]) throw bad(`${f} is required`);
    b.code = String(b.code).toUpperCase().trim();
    if (!/^[A-Z0-9-]{2,20}$/.test(b.code)) throw bad('Code may use letters, numbers and dashes only');
    const ref = D('kvks', b.code);
    await runTransaction(db, async (t) => {
      if ((await t.get(ref)).exists()) throw bad('A KVK with this code already exists');
      t.set(ref, { address: null, phone: null, host_institution: null, ...b, active: b.active ?? true, created_at: now() });
    });
    return one('kvks', b.code);
  });

  route('PUT', '/erp/kvks/:id', async ({ p, body }) => {
    const s = await staffMe();
    if (!isAdmin(s) && !(s.role === 'manager' && s.kvk_id === p.id)) throw forbidden();
    const b = clean(pick(body, isAdmin(s) ? KVK_FIELDS.filter((f) => f !== 'code') : ['address', 'phone']));
    if (!Object.keys(b).length) throw bad('Nothing to update');
    await updateDoc(D('kvks', p.id), b);
    return one('kvks', p.id);
  });

  // ---- Staff accounts ----
  route('GET', '/erp/users', async () => {
    const s = await staffMe();
    managerUp(s);
    const kvk = kvkOf(s, false);
    const rows = await list(kvk ? query(C('staff'), where('kvk_id', '==', kvk)) : query(C('staff'), where('role', '==', 'admin')));
    return rows.sort((a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name));
  });

  route('POST', '/erp/users', async ({ body }) => {
    const s = await staffMe();
    managerUp(s);
    const { name, email, password, role } = body || {};
    if (!name || !email || !password) throw bad('Name, email and password are required');
    if (String(password).length < 8) throw bad('Password must be at least 8 characters');
    if (!['admin', 'manager', 'staff'].includes(role)) throw bad('Role must be admin, manager or staff');
    if (role !== 'staff' && !isAdmin(s)) throw forbidden('Only national admins can create managers or admins');
    const kvk = role === 'admin' ? null : kvkOf(s);
    // Create the login on a secondary app so the current user stays signed in.
    if (!secondaryAuth) {
      const secApp = getApps().find((a) => a.name === 'staff-creator') || initializeApp(app.options, 'staff-creator');
      secondaryAuth = initializeAuth(secApp, { persistence: inMemoryPersistence });
      if (auth.emulatorConfig) connectAuthEmulator(secondaryAuth, `${auth.emulatorConfig.protocol}://${auth.emulatorConfig.host}:${auth.emulatorConfig.port}`, { disableWarnings: true });
    }
    const secAuth = secondaryAuth;
    let cred;
    try { cred = await createUserWithEmailAndPassword(secAuth, String(email).toLowerCase().trim(), String(password)); }
    catch (e) { throw bad(e.code === 'auth/email-already-in-use' ? 'This email is already in use' : e.message); }
    await signOut(secAuth);
    const row = { name, email: cred.user.email, role, kvk_id: kvk, active: true, created_at: now(), created_by: s.id };
    await setDoc(D('staff', cred.user.uid), row);
    return { id: cred.user.uid, ...row };
  });

  route('PUT', '/erp/users/:id', async ({ p, body }) => {
    const s = await staffMe();
    managerUp(s);
    const u = await one('staff', p.id);
    if (!u) throw notFound();
    if (!isAdmin(s) && (u.kvk_id !== s.kvk_id || u.role !== 'staff')) throw forbidden();
    if (u.id === s.id && body?.active === false) throw bad('You cannot deactivate yourself');
    if (body && 'active' in body) await updateDoc(D('staff', u.id), { active: !!body.active });
    return one('staff', u.id);
  });

  // ---- Equipment ----
  route('GET', '/erp/equipment', async () => {
    const s = await staffMe();
    const kvk = kvkOf(s);
    const today = todayIST();
    const [items, act] = await Promise.all([
      list(query(C('equipment'), where('kvk_id', '==', kvk))),
      list(query(C('bookings'), where('kvk_id', '==', kvk), where('status', 'in', ['requested', 'issued']))),
    ]);
    return items.sort((a, b) => b.active - a.active || byCatName(a, b)).map((e) => ({
      ...e,
      out_now: act.filter((b) => b.equipment_id === e.id && b.status === 'issued').reduce((n, b) => n + b.qty, 0),
      available_today: usage(e, today, today)[0].available,
      pending_requests: act.filter((b) => b.equipment_id === e.id && b.status === 'requested').length,
    }));
  });

  const validateEquip = (b) => { numOk(b.daily_rate, 'Daily rate'); numOk(b.total_qty, 'Quantity', { int: true }); numOk(b.max_days, 'Max days', { int: true, min: 1 }); };

  route('POST', '/erp/equipment', async ({ body }) => {
    const s = await staffMe();
    managerUp(s);
    const b = pick(body, EQUIP_FIELDS);
    if (!b.name || !b.category) throw bad('Name and category are required');
    validateEquip(b);
    const ref = doc(C('equipment'));
    const data = clean({ description: null, daily_rate: 0, total_qty: 1, max_days: 7, active: true, ...b });
    await setDoc(ref, { ...data, kvk_id: kvkOf(s), holds: {}, created_at: now() });
    return one('equipment', ref.id);
  });

  route('PUT', '/erp/equipment/:id', async ({ p, body }) => {
    const s = await staffMe();
    managerUp(s);
    const b = clean(pick(body, EQUIP_FIELDS));
    validateEquip(b);
    if (!Object.keys(b).length) throw bad('Nothing to update');
    await runTransaction(db, async (t) => {
      const e = owned(s, await txGet(t, 'equipment', p.id));
      if (b.total_qty !== undefined) {
        const today = todayIST();
        const last = Object.values(e.holds || {}).reduce((m, h) => (h.e > m ? h.e : m), today);
        const maxUsed = Math.max(0, ...usage(e, today, last).map((d) => d.used));
        if (b.total_qty < maxUsed) throw bad(`${maxUsed} units are already booked on some upcoming day; quantity cannot go below that`);
      }
      t.update(D('equipment', e.id), b);
    });
    return one('equipment', p.id);
  });

  route('GET', '/erp/equipment/:id/calendar', async ({ p, q }) => {
    const s = await staffMe();
    const e = owned(s, await one('equipment', p.id));
    const start = q.start ? parseDate(q.start, 'start') : todayIST();
    const end = q.end ? parseDate(q.end, 'end') : addDays(start, 13);
    if (end < start || daysInclusive(start, end) > 62) throw bad('Pick a range of up to 62 days');
    const bookings = (await list(query(C('bookings'), where('kvk_id', '==', e.kvk_id), where('equipment_id', '==', e.id), where('status', 'in', ['requested', 'approved', 'issued']))))
      .filter((b) => b.start_date <= end && b.end_date >= start).sort((a, b) => a.start_date.localeCompare(b.start_date));
    return { equipment: e, start, end, days: usage(e, start, end), bookings };
  });

  // ---- Stock ----
  route('GET', '/erp/stock', async ({ q }) => {
    const s = await staffMe();
    return (await list(query(C('stock_items'), where('kvk_id', '==', kvkOf(s)))))
      .filter((x) => !q.type || x.type === q.type)
      .sort((a, b) => b.active - a.active || byCatName(a, b));
  });

  route('POST', '/erp/stock', async ({ body }) => {
    const s = await staffMe();
    managerUp(s);
    const kvk = kvkOf(s);
    const b = pick(body, [...STOCK_FIELDS, 'quantity']);
    if (!b.name || !b.type) throw bad('Name and type are required');
    if (!['feed', 'fertilizer', 'seed', 'other'].includes(b.type)) throw bad('Type must be feed, fertilizer, seed or other');
    numOk(b.quantity, 'Quantity'); numOk(b.price_per_unit, 'Price'); numOk(b.reorder_level, 'Reorder level');
    const data = clean({ unit: 'kg', quantity: 0, price_per_unit: 0, reorder_level: 0, certified: true, active: true, ...b });
    const ref = doc(C('stock_items'));
    const batch = writeBatch(db);
    batch.set(ref, { ...data, kvk_id: kvk, updated_at: now() });
    if (data.quantity > 0) batch.set(doc(C('stock_movements')), { item_id: ref.id, kvk_id: kvk, change: data.quantity, reason: 'opening', note: null, user_id: s.id, user_name: s.name, created_at: now() });
    await batch.commit();
    return one('stock_items', ref.id);
  });

  route('PUT', '/erp/stock/:id', async ({ p, body }) => {
    const s = await staffMe();
    managerUp(s);
    owned(s, await one('stock_items', p.id));
    const b = clean(pick(body, STOCK_FIELDS));
    numOk(b.price_per_unit, 'Price'); numOk(b.reorder_level, 'Reorder level');
    if (!Object.keys(b).length) throw bad('Nothing to update');
    await updateDoc(D('stock_items', p.id), { ...b, updated_at: now() });
    return one('stock_items', p.id);
  });

  route('POST', '/erp/stock/:id/adjust', async ({ p, body }) => {
    const s = await staffMe();
    const change = Number(body?.change);
    if (!change || Number.isNaN(change)) throw bad('Enter a quantity');
    if (!['received', 'sold', 'issued', 'damaged', 'correction'].includes(body?.reason)) throw bad('Choose a reason');
    return runTransaction(db, async (t) => {
      const it = owned(s, await txGet(t, 'stock_items', p.id));
      if (it.quantity + change < 0) throw bad(`Only ${it.quantity} ${it.unit} in stock`);
      const quantity = Math.round((it.quantity + change) * 1000) / 1000;
      t.update(D('stock_items', it.id), { quantity, updated_at: now() });
      t.set(doc(C('stock_movements')), { item_id: it.id, kvk_id: it.kvk_id, change, reason: body.reason, note: body.note || null, user_id: s.id, user_name: s.name, created_at: now() });
      return { ...it, quantity };
    });
  });

  route('GET', '/erp/stock/:id/movements', async ({ p }) => {
    const s = await staffMe();
    const it = owned(s, await one('stock_items', p.id));
    return (await list(query(C('stock_movements'), where('kvk_id', '==', it.kvk_id), where('item_id', '==', it.id))))
      .sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 200);
  });

  // ---- Farmers ----
  route('GET', '/erp/farmers', async ({ q }) => {
    const s = await staffMe();
    const kvk = kvkOf(s);
    const text = String(q.q || '').toLowerCase();
    const fq = q.status ? query(C('farmers'), where('kvk_id', '==', kvk), where('status', '==', q.status)) : query(C('farmers'), where('kvk_id', '==', kvk));
    const [farmers, bookings] = await Promise.all([list(fq), list(query(C('bookings'), where('kvk_id', '==', kvk)))]);
    const counts = {};
    for (const b of bookings) counts[b.farmer_id] = (counts[b.farmer_id] || 0) + 1;
    return farmers.filter((f) => !text || `${f.name} ${f.phone} ${f.village}`.toLowerCase().includes(text))
      .map((f) => ({ ...f, bookings: counts[f.id] || 0 }))
      .sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || (b.created_at || '').localeCompare(a.created_at || ''))
      .slice(0, 500);
  });

  route('POST', '/erp/farmers/:id/verify', async ({ p, body }) => {
    const s = await staffMe();
    const f = owned(s, await one('farmers', p.id));
    const { decision, note } = body || {};
    if (!['verified', 'rejected'].includes(decision)) throw bad('Decision must be verified or rejected');
    if (decision === 'rejected' && !note) throw bad('Please give a reason so the farmer knows what to fix');
    await updateDoc(D('farmers', f.id), { status: decision, status_note: note || null, verified_by: s.id, verified_at: now() });
    return one('farmers', f.id);
  });

  // ---- Bookings ----
  route('GET', '/erp/bookings', async ({ q }) => {
    const s = await staffMe();
    const kvk = kvkOf(s);
    let bq = query(C('bookings'), where('kvk_id', '==', kvk));
    if (q.status === 'active') bq = query(bq, where('status', 'in', ['requested', 'approved', 'issued']));
    else if (q.status) bq = query(bq, where('status', '==', q.status));
    const order = { requested: 0, approved: 1, issued: 2 };
    const rows = (await list(bq)).sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3) || a.start_date.localeCompare(b.start_date)).slice(0, 500);
    const eqIds = [...new Set(rows.filter((b) => b.status === 'requested').map((b) => b.equipment_id))];
    const eqs = Object.fromEntries((await Promise.all(eqIds.map((id) => one('equipment', id)))).filter(Boolean).map((e) => [e.id, e]));
    return rows.map((b) => (b.status === 'requested' && eqs[b.equipment_id]
      ? { ...b, total_qty: eqs[b.equipment_id].total_qty, available: minAvail(eqs[b.equipment_id], b.start_date, b.end_date) } : b));
  });

  /** Change a booking's status in a transaction that also updates the equipment's holds,
   *  so two staff approving the same machine at once cannot both succeed. */
  const transition = (from, to, apply) => async ({ p, body }) => {
    const s = await staffMe();
    await runTransaction(db, async (t) => {
      const b = owned(s, await txGet(t, 'bookings', p.id));
      if (!from.includes(b.status)) throw bad(`Booking is ${b.status}; cannot change it to ${to}`);
      const e = await txGet(t, 'equipment', b.equipment_id);
      const { booking, holds } = await apply({ b, e, s, body: body || {}, t });
      t.update(D('bookings', b.id), { status: to, ...booking });
      t.update(D('equipment', e.id), { ...pruneHolds(e), ...holds, booking_rev: increment(1) });
    });
    return one('bookings', p.id);
  };

  route('POST', '/erp/bookings/:id/approve', transition(['requested'], 'approved', async ({ b, e, s, body, t }) => {
    const f = await txGet(t, 'farmers', b.farmer_id);
    if (f?.status !== 'verified') throw bad('Farmer is not verified');
    const avail = minAvail(e, b.start_date, b.end_date, b.id);
    if (avail < b.qty) throw bad(`Only ${avail} available on these dates; reject or ask the farmer to pick other dates`);
    return {
      booking: { staff_note: body.note || null, decided_by: s.id, decided_at: now(), amount: e.daily_rate * b.qty * daysInclusive(b.start_date, b.end_date) },
      holds: { [`holds.${b.id}`]: { qty: b.qty, s: b.start_date, e: b.end_date } },
    };
  }));

  route('POST', '/erp/bookings/:id/reject', transition(['requested', 'approved'], 'rejected', async ({ b, s, body }) => {
    if (!body.note) throw bad('Please give a reason for the farmer');
    return { booking: { staff_note: body.note, decided_by: s.id, decided_at: now() }, holds: { [`holds.${b.id}`]: deleteField() } };
  }));

  route('POST', '/erp/bookings/:id/issue', transition(['approved'], 'issued', async ({ s }) => ({ booking: { issued_at: now(), issued_by: s.id }, holds: {} })));

  route('POST', '/erp/bookings/:id/return', transition(['issued'], 'returned', async ({ b, s, body }) => {
    const condition = body.condition || 'good';
    if (!['good', 'minor_damage', 'damaged'].includes(condition)) throw bad('Condition must be good, minor_damage or damaged');
    const today = todayIST();
    const end_date = b.end_date > today && b.start_date <= today ? today : b.end_date; // early return frees remaining days
    return {
      booking: { returned_at: now(), return_condition: condition, end_date, staff_note: body.note || b.staff_note || null, received_by: s.id },
      holds: { [`holds.${b.id}`]: deleteField() },
    };
  }));

  // ======================= first-time setup =======================
  route('GET', '/setup/status', async () => ({ done: (await getDoc(D('config', 'setup'))).exists() }));

  // The first signed-in email user claims national admin; the rules lock this after one use.
  route('POST', '/setup/claim-admin', async ({ body }) => {
    const u = user();
    if (!u.email) throw bad('Sign in with email to set up the admin account');
    const batch = writeBatch(db);
    batch.set(D('staff', u.uid), { name: body?.name || 'National Admin', email: u.email, role: 'admin', kvk_id: null, active: true, created_at: now() });
    batch.set(D('config', 'setup'), { admin_uid: u.uid, at: now() });
    try { await batch.commit(); } catch (e) { throw e.code === 'permission-denied' ? forbidden('Setup has already been completed') : e; }
    staffCache = null;
    return { ok: true };
  });

  // Admin: load sample KVKs with equipment and stock (for demos). Safe to run once.
  route('POST', '/erp/demo-data', async () => {
    const s = await staffMe();
    if (!isAdmin(s)) throw forbidden('Only national admins can do this');
    const { DEMO_KVKS, DEMO_EQUIPMENT, DEMO_STOCK } = await import('./demo-data.js');
    let made = 0;
    for (const [i, [code, name, state, district, address, phone, host]] of DEMO_KVKS.entries()) {
      if ((await getDoc(D('kvks', code))).exists()) continue;
      const batch = writeBatch(db);
      const t0 = now();
      batch.set(D('kvks', code), { code, name, state, district, address, phone, host_institution: host, active: true, created_at: t0 });
      DEMO_EQUIPMENT.forEach(([key, n, category, description, daily_rate, total_qty, max_days], j) => {
        if ((i + j) % 5 === 4 && i !== 0) return;
        batch.set(D('equipment', `${code}-${key}`), { kvk_id: code, name: n, category, description, daily_rate, total_qty, max_days, active: true, holds: {}, created_at: t0 });
      });
      DEMO_STOCK.forEach(([type, n, unit, q, price, reorder], j) => {
        const quantity = i === 0 ? q : Math.round((q * ((i + j) % 4)) / 2);
        const ref = doc(C('stock_items'));
        batch.set(ref, { kvk_id: code, type, name: n, unit, quantity, price_per_unit: price, reorder_level: reorder, certified: true, active: true, updated_at: t0 });
        if (quantity > 0) batch.set(doc(C('stock_movements')), { item_id: ref.id, kvk_id: code, change: quantity, reason: 'opening', note: null, user_id: s.id, user_name: s.name, created_at: t0 });
      });
      await batch.commit();
      made++;
    }
    return { kvks_created: made };
  });

  // ======================= dispatcher =======================
  async function api(path, { method = 'GET', body } = {}) {
    const [p, qs = ''] = path.split('?');
    const q = Object.fromEntries(new URLSearchParams(qs));
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = p.match(r.re);
      if (!m) continue;
      try { return await r.fn({ p: Object.fromEntries(Object.entries(m.groups || {}).map(([k, v]) => [k, decodeURIComponent(v)])), q, body }); }
      catch (e) { throw friendly(e); }
    }
    throw notFound(`No route for ${method} ${p}`);
  }
  api.setActiveKvk = (id) => { activeKvk = id || null; };
  api.resetSession = () => { staffCache = null; };
  auth.onAuthStateChanged(() => { staffCache = null; });
  return api;
}
