// Runs against the Firebase emulators (Auth + Firestore with firestore.rules): `npm test`.
// Each actor is a separate Firebase client app, so these tests exercise the security rules too.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, deleteApp, getApps } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInWithEmailAndPassword } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator, doc, updateDoc, getDoc } from 'firebase/firestore';
import { getAuth as adminAuth } from 'firebase-admin/auth';
import { createBackend, todayIST, addDays, farmerEmail } from '../shared/backend.js';
import { seed } from '../scripts/seed.js';

const today = todayIST();
let n = 0;
async function actor(signIn) {
  const app = initializeApp({ apiKey: 'demo-key', projectId: process.env.GCLOUD_PROJECT || 'demo-kvk' }, `actor-${n++}`);
  const auth = getAuth(app);
  connectAuthEmulator(auth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true });
  const db = getFirestore(app);
  const [h, p] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
  connectFirestoreEmulator(db, h, Number(p));
  if (signIn) await signIn(auth);
  const api = createBackend(app);
  api.db = db; api.auth = auth;
  return api;
}
const staff = (email, password) => actor((a) => signInWithEmailAndPassword(a, email, password));
const cache = {};
// Farmers log in with mobile number + password (mapped to <number>@farmer.kvk.in)
const farmer = async (phone) => (cache[phone] ??= actor(async (a) => {
  const email = farmerEmail(phone);
  try { await adminAuth().getUserByEmail(email); } catch { await adminAuth().createUser({ email, password: 'kisan123' }); }
  await signInWithEmailAndPassword(a, email, 'kisan123');
}));
const anon = () => actor();

async function call(method, path, body, who, headers = {}) {
  who ??= await anon();
  who.setActiveKvk(headers['x-kvk-id'] || null);
  try { return { status: 200, body: await who(path.replace(/^\/api/, ''), { method, body }) }; }
  catch (e) { return { status: e.status || 500, body: { error: e.message } }; }
}

before(async () => { await seed(); });
after(async () => { await Promise.all(getApps().map((a) => deleteApp(a))); });

test('public directory lists KVKs and stock', async () => {
  const kvks = await call('GET', '/api/public/kvks?state=Punjab');
  assert.equal(kvks.body.length, 2);
  const k = await call('GET', '/api/public/kvks/PB-LDH');
  assert.equal(k.body.equipment.length, 10);
  assert.ok(k.body.stock.some((s) => s.level === 'out'));
  const a = await call('GET', '/api/public/kvks/PB-LDH/availability');
  assert.equal(a.body.equipment.find((e) => e.id === 'PB-LDH-happyseeder').days[0].available, 0);
});

test('unauthenticated and wrong-kind tokens are refused', async () => {
  assert.equal((await call('GET', '/api/erp/dashboard')).status, 401);
  const ft = await farmer('9876500003');
  assert.equal((await call('GET', '/api/erp/dashboard', null, ft)).status, 403);
  const st = await staff('staff.ludhiana@kvk.in', 'staff1234');
  assert.equal((await call('GET', '/api/farmer/me', null, st)).status, 403);
});

test('new farmer must be verified before booking, then full booking lifecycle', async () => {
  const ft = await farmer('9123456789');
  const tractor = 'PB-LDH-tractor'; // 2 units
  const s = addDays(today, 10), e = addDays(today, 11);

  let r = await call('GET', '/api/farmer/me', null, ft);
  assert.equal(r.body.status, 'new');
  assert.equal(r.body.phone, '9123456789');
  r = await call('POST', '/api/farmer/bookings', { equipment_id: tractor, start_date: s, end_date: e }, ft);
  assert.equal(r.status, 403);

  r = await call('PUT', '/api/farmer/me', { name: 'Test Farmer', village: 'Jodhan', kvk_id: 'PB-LDH', id_last4: '4321' }, ft);
  assert.equal(r.body.status, 'pending', JSON.stringify(r.body));

  const mt = await staff('manager.ludhiana@kvk.in', 'manager123');
  const pending = await call('GET', '/api/erp/farmers?status=pending', null, mt);
  const me = pending.body.find((f) => f.phone === '9123456789');
  assert.ok(me);
  r = await call('POST', `/api/erp/farmers/${me.id}/verify`, { decision: 'verified' }, mt);
  assert.equal(r.body.status, 'verified');

  r = await call('POST', '/api/farmer/bookings', { equipment_id: tractor, start_date: s, end_date: e }, ft);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.amount, 1600);
  const id = r.body.id;

  for (const step of ['approve', 'issue']) {
    r = await call('POST', `/api/erp/bookings/${id}/${step}`, {}, mt);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  r = await call('POST', `/api/erp/bookings/${id}/return`, { condition: 'good' }, mt);
  assert.equal(r.body.status, 'returned');
  r = await call('POST', `/api/erp/bookings/${id}/approve`, {}, mt);
  assert.equal(r.status, 400);
  const mine = await call('GET', '/api/farmer/bookings', null, ft);
  assert.equal(mine.body[0].status, 'returned');
});

test('capacity: approvals cannot overbook, even when approved at the same moment', async () => {
  const mt = await staff('manager.ludhiana@kvk.in', 'manager123');
  const st = await staff('staff.ludhiana@kvk.in', 'staff1234');
  const leveller = 'PB-LDH-leveller'; // 1 unit
  const s = addDays(today, 20);
  const a = await call('POST', '/api/farmer/bookings', { equipment_id: leveller, start_date: s, end_date: s }, await farmer('9876500001'));
  const b = await call('POST', '/api/farmer/bookings', { equipment_id: leveller, start_date: s, end_date: s }, await farmer('9876500002'));
  assert.equal(a.status, 200);
  assert.equal(b.status, 200); // requests don't block each other
  const results = await Promise.all([
    call('POST', `/api/erp/bookings/${a.body.id}/approve`, {}, mt),
    call('POST', `/api/erp/bookings/${b.body.id}/approve`, {}, st),
  ]);
  assert.deepEqual(results.map((x) => x.status).sort(), [200, 400]);
  const avail = await call('GET', `/api/public/kvks/PB-LDH/availability?start=${s}&end=${s}`);
  assert.equal(avail.body.equipment.find((x) => x.id === leveller).min_available, 0);
  const c = await call('POST', '/api/farmer/bookings', { equipment_id: leveller, start_date: addDays(s, 0), end_date: s }, await farmer('9876500002'));
  assert.equal(c.status, 400);
});

test('staff are confined to their own KVK', async () => {
  const other = await staff('manager.amritsar@kvk.in', 'manager123');
  const mt = await staff('manager.ludhiana@kvk.in', 'manager123');
  const req = (await call('GET', '/api/erp/bookings?status=requested', null, mt)).body[0];
  assert.equal((await call('POST', `/api/erp/bookings/${req.id}/approve`, {}, other)).status, 403);
  assert.equal((await call('GET', '/api/erp/bookings', null, other)).body.length, 0);
});

test('admin picks a KVK via header; stock adjustments are logged and cannot go negative', async () => {
  const at = await staff('admin@kvk.in', 'admin12345');
  assert.equal((await call('GET', '/api/erp/dashboard', null, at)).body.scope, 'national');
  assert.equal((await call('GET', '/api/erp/stock', null, at)).status, 400);
  const H = { 'x-kvk-id': 'PB-LDH' };
  const item = (await call('GET', '/api/erp/stock?type=feed', null, at, H)).body[0];
  let r = await call('POST', `/api/erp/stock/${item.id}/adjust`, { change: -(item.quantity + 1), reason: 'sold' }, at, H);
  assert.equal(r.status, 400);
  r = await call('POST', `/api/erp/stock/${item.id}/adjust`, { change: 50, reason: 'received' }, at, H);
  assert.equal(r.body.quantity, item.quantity + 50);
  const moves = await call('GET', `/api/erp/stock/${item.id}/movements`, null, at, H);
  assert.equal(moves.body[0].change, 50);
});

test('managers create staff who can sign in; staff cannot edit the catalogue', async () => {
  const mt = await staff('manager.ludhiana@kvk.in', 'manager123');
  const r = await call('POST', '/api/erp/users', { name: 'New Staff', email: 'new.staff@kvk.in', password: 'password1', role: 'staff' }, mt);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const nt = await staff('new.staff@kvk.in', 'password1');
  const me = await call('GET', '/api/erp/me', null, nt);
  assert.equal(me.body.kvk.id, 'PB-LDH');
  assert.equal((await call('POST', '/api/erp/equipment', { name: 'X', category: 'Other' }, nt)).status, 403);
  assert.equal((await call('POST', '/api/erp/users', { name: 'A', email: 'a@kvk.in', password: 'password1', role: 'manager' }, mt)).status, 403);
});

test('farmer cannot book at another KVK or in the past', async () => {
  const ft = await farmer('9876500001');
  let r = await call('POST', '/api/farmer/bookings', { equipment_id: 'PB-ASR-tractor', start_date: addDays(today, 3), end_date: addDays(today, 3) }, ft);
  assert.equal(r.status, 403);
  r = await call('POST', '/api/farmer/bookings', { equipment_id: 'PB-LDH-rotavator', start_date: addDays(today, -2), end_date: today }, ft);
  assert.equal(r.status, 400);
});

test('rules block direct writes that bypass the app', async () => {
  const pending = await farmer('9876500004'); // pending farmer
  await pending('/farmer/me');
  const uid = pending.auth.currentUser.uid;
  await assert.rejects(updateDoc(doc(pending.db, 'farmers', uid), { status: 'verified' }), /permission/i);
  // pending farmer cannot sneak a booking in directly
  const { setDoc } = await import('firebase/firestore');
  await assert.rejects(setDoc(doc(pending.db, 'bookings', 'hack1'), {
    farmer_id: uid, kvk_id: 'PB-LDH', equipment_id: 'PB-LDH-tractor', status: 'requested', qty: 1, start_date: today, end_date: today,
  }), /permission/i);
  // a verified farmer cannot create an already-approved booking or edit equipment holds
  const ok = await farmer('9876500002');
  await ok('/farmer/me');
  await assert.rejects(setDoc(doc(ok.db, 'bookings', 'hack2'), {
    farmer_id: ok.auth.currentUser.uid, kvk_id: 'PB-LDH', equipment_id: 'PB-LDH-tractor', status: 'approved', qty: 1, start_date: today, end_date: today,
  }), /permission/i);
  await assert.rejects(updateDoc(doc(ok.db, 'equipment', 'PB-LDH-tractor'), { holds: {} }), /permission/i);
  // staff cannot read another KVK's farmers or change stock to negative
  const other = await staff('staff.amritsar@kvk.in', 'staff1234');
  await assert.rejects(getDoc(doc(other.db, 'farmers', uid)), /permission/i);
  const st = await staff('staff.ludhiana@kvk.in', 'staff1234');
  const item = (await st('/erp/stock')).find((s) => s.quantity > 0);
  await assert.rejects(updateDoc(doc(st.db, 'stock_items', item.id), { quantity: -5 }), /permission/i);
  // staff (not manager) cannot change rent
  await assert.rejects(updateDoc(doc(st.db, 'equipment', 'PB-LDH-tractor'), { daily_rate: 1 }), /permission/i);
  // anyone can read the public catalogue
  const a = await anon();
  assert.ok((await getDoc(doc(a.db, 'equipment', 'PB-LDH-tractor'))).exists());
});

test('first-time setup: only the first person can claim national admin', async () => {
  const { getFirestore: adminDb } = await import('firebase-admin/firestore');
  await adminDb().collection('config').doc('setup').delete();
  for (const e of ['owner@kvk.in', 'intruder@kvk.in']) { try { await adminAuth().createUser({ email: e, password: 'password1' }); } catch { /* exists */ } }
  const owner = await staff('owner@kvk.in', 'password1');
  assert.equal((await owner('/setup/status')).done, false);
  await owner('/setup/claim-admin', { method: 'POST', body: { name: 'Owner' } });
  assert.equal((await owner('/erp/me')).role, 'admin');
  const intruder = await staff('intruder@kvk.in', 'password1');
  const r = await call('POST', '/setup/claim-admin', { name: 'X' }, intruder);
  assert.equal(r.status, 403);
  assert.equal((await call('GET', '/erp/me', null, intruder)).status, 403);
  // admin can load the demo catalogue (skips KVKs that already exist)
  await adminDb().recursiveDelete(adminDb().collection('kvks').doc('TN-CBE'));
  const res = await owner('/erp/demo-data', { method: 'POST' });
  assert.equal(res.kvks_created, 1);
  const st = await owner('/public/kvks/TN-CBE');
  assert.ok(st.stock.length > 0);
});

test('trainings: staff propose, manager approves; farmers see schedule, steps, documents and form', async () => {
  const st = await staff('staff.ludhiana@kvk.in', 'staff1234');
  const mt = await staff('manager.ludhiana@kvk.in', 'manager123');
  // Seeded demo trainings are visible to anyone
  let r = await call('GET', '/api/public/kvks/PB-LDH/trainings');
  assert.equal(r.body.length, 5);
  assert.ok(r.body.every((tr) => tr.registration_open && tr.form?.url));

  const pdf = Buffer.from('%PDF-1.4 sample application form').toString('base64');
  const body = {
    title: 'Bee keeping', category: 'Horticulture', audience: 'Farmers', start_date: addDays(today, 8), end_date: addDays(today, 12), venue: '',
    last_date: addDays(today, 5), timing: '10 AM – 4 PM', seats: '25', fee: '0',
    steps: 'Download the form\nVisit the KVK office', documents: 'Aadhaar copy\n\nTwo photos\n',
    form_file: { name: 'beekeeping-form.pdf', type: 'application/pdf', data: pdf },
  };
  r = await call('POST', '/api/erp/trainings', body, st);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const id = r.body.id;
  assert.equal(r.body.status, 'proposed');
  assert.deepEqual(r.body.documents, ['Aadhaar copy', 'Two photos']);
  assert.equal(r.body.seats, 25);
  assert.equal(r.body.form.name, 'beekeeping-form.pdf');
  assert.equal(r.body.kvk_id, 'PB-LDH');

  // A proposal is invisible to farmers until a manager approves it
  const ft = await farmer('9876500001');
  assert.equal((await call('GET', '/api/public/kvks/PB-LDH/trainings')).body.some((tr) => tr.id === id), false);
  assert.equal((await call('GET', `/api/public/trainings/${id}`, null, ft)).status, 404);
  await assert.rejects(getDoc(doc(ft.db, 'trainings', id)));
  assert.equal((await call('POST', `/api/erp/trainings/${id}/approve`, null, st)).status, 403); // staff cannot approve
  // Manager sends it back with a note; staff fixes it, which resubmits it
  assert.equal((await call('POST', `/api/erp/trainings/${id}/reject`, {}, mt)).status, 400);
  r = await call('POST', `/api/erp/trainings/${id}/reject`, { note: 'Add the venue' }, mt);
  assert.equal(r.body.status, 'rejected');
  r = await call('PUT', `/api/erp/trainings/${id}`, { venue: 'Seminar hall' }, st);
  assert.equal(r.body.status, 'proposed');
  assert.equal((await call('GET', '/api/erp/dashboard', null, mt)).body.trainings_proposed, 1);
  r = await call('POST', `/api/erp/trainings/${id}/approve`, null, mt);
  assert.equal(r.body.status, 'published');
  // Staff cannot change or delete it once published, and cannot publish directly
  assert.equal((await call('PUT', `/api/erp/trainings/${id}`, { title: 'Changed' }, st)).status, 403);
  assert.equal((await call('DELETE', `/api/erp/trainings/${id}`, null, st)).status, 403);
  await assert.rejects(updateDoc(doc(st.db, 'trainings', id), { title: 'Changed' }));
  // Managers publish straight away
  r = await call('POST', '/api/erp/trainings', { ...body, form_file: undefined, title: 'Kitchen gardening' }, mt);
  assert.equal(r.body.status, 'published');
  await call('DELETE', `/api/erp/trainings/${r.body.id}`, null, mt);

  // Farmer (or anyone) reads details and downloads the exact file
  r = await call('GET', `/api/public/trainings/${id}`, null, ft);
  assert.equal(r.body.kvk.name, 'KVK Ludhiana');
  assert.deepEqual(r.body.steps, ['Download the form', 'Visit the KVK office']);
  r = await call('GET', `/api/public/trainings/${id}/form`);
  assert.equal(r.body.data, pdf);
  assert.equal(r.body.type, 'application/pdf');

  // Replace the file with a link, then hide the training
  r = await call('PUT', `/api/erp/trainings/${id}`, { form_url: 'https://example.org/form.pdf', form_name: 'Form (PDF)' }, mt);
  assert.equal(r.body.form.url, 'https://example.org/form.pdf');
  assert.equal((await getDoc(doc(mt.db, 'training_forms', id))).exists(), false);
  r = await call('PUT', `/api/erp/trainings/${id}`, { active: false }, mt);
  assert.equal((await call('GET', '/api/public/kvks/PB-LDH/trainings')).body.some((tr) => tr.id === id), false);

  // Seats can be left empty
  r = await call('POST', '/api/erp/trainings', { ...body, seats: '', form_file: undefined }, st);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.seats, null);
  await call('DELETE', `/api/erp/trainings/${r.body.id}`, null, st);

  // Validation
  r = await call('POST', '/api/erp/trainings', { ...body, end_date: addDays(today, 1) }, st);
  assert.equal(r.status, 400);
  r = await call('POST', '/api/erp/trainings', { ...body, form_file: { name: 'x.exe', data: pdf } }, st);
  assert.equal(r.status, 400);
  const big = Buffer.alloc(800 * 1024).toString('base64');
  r = await call('POST', '/api/erp/trainings', { ...body, form_file: { name: 'big.pdf', data: big } }, st);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /KB or smaller/);

  // Other KVKs and farmers cannot change it
  const other = await staff('manager.karnal@kvk.in', 'manager123');
  assert.equal((await call('PUT', `/api/erp/trainings/${id}`, { title: 'Hacked' }, other)).status, 403);
  await assert.rejects(updateDoc(doc(ft.db, 'trainings', id), { title: 'Hacked' }));

  // Delete removes it
  r = await call('DELETE', `/api/erp/trainings/${id}`, null, mt);
  assert.equal(r.status, 200);
  assert.equal((await call('GET', `/api/public/trainings/${id}`)).status, 404);
});
