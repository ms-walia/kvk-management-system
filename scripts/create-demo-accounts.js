// Create demo logins and sample data in a REAL Firebase project (Spark plan, client SDK only).
// Requires firestore.rules to be deployed first. Safe to re-run: existing accounts are reused.
//
//   FIREBASE_API_KEY=... FIREBASE_PROJECT_ID=kvk-management-system \
//   ADMIN_PASSWORD=... STAFF_PASSWORD=... FARMER_PASSWORD=... node scripts/create-demo-accounts.js
// Passwords are passed in, never stored in the repo.
import { initializeApp, deleteApp, getApps } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, connectAuthEmulator } from 'firebase/auth';
import { getFirestore, doc, getDoc, connectFirestoreEmulator } from 'firebase/firestore';
import { createBackend, farmerEmail, todayIST, addDays } from '../shared/backend.js';

const apiKey = process.env.FIREBASE_API_KEY;
const projectId = process.env.FIREBASE_PROJECT_ID || 'kvk-management-system';
if (!apiKey) { console.error('Set FIREBASE_API_KEY (Firebase console > Project settings > Web app)'); process.exit(1); }
const config = { apiKey, projectId, authDomain: `${projectId}.firebaseapp.com` };
const { ADMIN_PASSWORD, STAFF_PASSWORD, FARMER_PASSWORD } = process.env;
if (!ADMIN_PASSWORD || !STAFF_PASSWORD || !FARMER_PASSWORD) { console.error('Set ADMIN_PASSWORD, STAFF_PASSWORD and FARMER_PASSWORD'); process.exit(1); }

export const ADMIN = { email: 'admin@kvk.in', password: ADMIN_PASSWORD, name: 'National Admin' };
export const STAFF = [
  { kvk: 'PB-LDH', email: 'manager.ludhiana@kvk.in', password: STAFF_PASSWORD, name: 'Manager Ludhiana', role: 'manager' },
  { kvk: 'PB-LDH', email: 'staff.ludhiana@kvk.in', password: STAFF_PASSWORD, name: 'Staff Ludhiana', role: 'staff' },
  { kvk: 'HR-KNL', email: 'manager.karnal@kvk.in', password: STAFF_PASSWORD, name: 'Manager Karnal', role: 'manager' },
  { kvk: 'MH-PUN', email: 'manager.baramati@kvk.in', password: STAFF_PASSWORD, name: 'Manager Baramati', role: 'manager' },
];
export const FARMERS = [
  { phone: '9876500001', name: 'Gurpreet Singh', village: 'Jodhan', kvk: 'PB-LDH', land: 6.5, verify: true },
  { phone: '9876500002', name: 'Harjit Kaur', village: 'Dehlon', kvk: 'PB-LDH', land: 3, verify: true },
  { phone: '9876500003', name: 'Ramesh Kumar', village: 'Mullanpur', kvk: 'PB-LDH', land: 2, verify: false },
  { phone: '9876500011', name: 'Suresh Yadav', village: 'Gharaunda', kvk: 'HR-KNL', land: 4, verify: true },
];

let n = 0;
/** A separate signed-in client for each person. */
async function session(email, password, create = true) {
  const app = initializeApp(config, `s${n++}`);
  const auth = getAuth(app);
  if (process.env.USE_EMULATOR) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFirestoreEmulator(getFirestore(app), '127.0.0.1', 8080);
  }
  try { await signInWithEmailAndPassword(auth, email, password); }
  catch (e) {
    if (!create) throw e;
    try { await createUserWithEmailAndPassword(auth, email, password); }
    catch (e2) { throw new Error(`${email}: ${e2.code === 'auth/email-already-in-use' ? 'exists with a different password' : e2.message}`); }
  }
  const api = createBackend(app);
  api.uid = auth.currentUser.uid;
  api.db = getFirestore(app);
  return api;
}

const log = (...a) => console.log('  ', ...a);

// 1. National admin (claims first-time setup if nobody has)
console.log('Admin');
const admin = await session(ADMIN.email, ADMIN.password);
const setup = await getDoc(doc(admin.db, 'config', 'setup'));
if (!setup.exists()) { await admin('/setup/claim-admin', { method: 'POST', body: { name: ADMIN.name } }); log('claimed national admin'); }
try { await admin('/erp/me'); log(`${ADMIN.email} ok`); }
catch { console.error(`Setup was already claimed by another account; ${ADMIN.email} is not an admin. Sign in as that admin and add it.`); process.exit(1); }

// 2. Sample KVKs with equipment and stock
console.log('KVKs');
log(`sample KVKs created: ${(await admin('/erp/demo-data', { method: 'POST' })).kvks_created}`);

// 3. KVK managers and staff
console.log('Staff');
for (const s of STAFF) {
  admin.setActiveKvk(s.kvk);
  const existing = (await admin('/erp/users')).find((u) => u.email === s.email);
  if (existing) { log(`${s.email} exists`); continue; }
  try { await admin('/erp/users', { method: 'POST', body: { name: s.name, email: s.email, password: s.password, role: s.role } }); log(`${s.email} created`); }
  catch (e) { log(`${s.email}: ${e.message}`); }
}

// 4. Farmers: account + profile, then verification by the KVK
console.log('Farmers');
const farmers = {};
for (const f of FARMERS) {
  const api = await session(farmerEmail(f.phone), FARMER_PASSWORD);
  const me = await api('/farmer/me');
  if (me.status === 'new' || me.status === 'rejected') {
    await api('/farmer/me', { method: 'PUT', body: { name: f.name, village: f.village, kvk_id: f.kvk, id_type: 'Aadhaar', id_last4: f.phone.slice(-4), land_acres: f.land } });
  }
  if (f.verify && me.status !== 'verified') {
    admin.setActiveKvk(f.kvk);
    await admin(`/erp/farmers/${api.uid}/verify`, { method: 'POST', body: { decision: 'verified' } });
  }
  farmers[f.phone] = api;
  log(`${f.phone} (${f.name}) ${f.verify ? 'verified' : 'waiting for verification'}`);
}

// 5. A few bookings so the dashboards are not empty
console.log('Bookings');
const t = todayIST();
const book = async (phone, equipment_id, start, end, approve = false, note = null) => {
  const api = farmers[phone];
  const mine = await api('/farmer/bookings');
  if (mine.some((b) => b.equipment_id === equipment_id && ['requested', 'approved', 'issued'].includes(b.status))) return log(`${equipment_id} for ${phone} exists`);
  try {
    const b = await api('/farmer/bookings', { method: 'POST', body: { equipment_id, start_date: start, end_date: end, note } });
    if (approve) { admin.setActiveKvk(b.kvk_id); await admin(`/erp/bookings/${b.id}/approve`, { method: 'POST' }); }
    log(`${equipment_id} ${start}..${end} ${approve ? 'approved' : 'requested'}`);
  } catch (e) { log(`${equipment_id}: ${e.message}`); }
};
await book('9876500001', 'PB-LDH-tractor', addDays(t, 2), addDays(t, 3), false, 'Wheat sowing, 5 acres');
await book('9876500002', 'PB-LDH-sprayer', addDays(t, 1), addDays(t, 2), true);
await book('9876500001', 'PB-LDH-happyseeder', addDays(t, 4), addDays(t, 5), true);
await book('9876500011', 'HR-KNL-rotavator', addDays(t, 3), addDays(t, 3));

for (const a of getApps()) { try { await signOut(getAuth(a)); } catch { /* ignore */ } await deleteApp(a); }
console.log('Done.');
process.exit(0);
