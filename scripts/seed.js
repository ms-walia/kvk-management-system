// Load demo data into the local Firebase emulators (wipes existing emulator data).
// Run from the repo root: `npm run seed` while `npm run emulators` is running.
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { todayIST, addDays } from '../shared/backend.js';
import { DEMO_KVKS as KVKS, DEMO_EQUIPMENT as EQUIPMENT, DEMO_STOCK as STOCK } from '../shared/demo-data.js';

if (!getApps().length) initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-kvk' });
const db = getFirestore();
const auth = getAuth();
const col = Object.fromEntries(['kvks', 'staff', 'farmers', 'equipment', 'bookings'].map((c) => [c, () => db.collection(c)]));
col.stock = () => db.collection('stock_items');
col.movements = () => db.collection('stock_movements');




// Demo farmers at KVK Ludhiana. In the emulator, sign in with these numbers; the OTP appears in the emulator UI/logs.
const FARMERS = [
  ['9876500001', 'Gurpreet Singh', 'Jodhan', 'verified', 6.5],
  ['9876500002', 'Harjit Kaur', 'Dehlon', 'verified', 3],
  ['9876500003', 'Ramesh Kumar', 'Mullanpur', 'pending', 2],
  ['9876500004', 'Sukhwinder Singh', 'Pakhowal', 'pending', 12],
  ['9876500005', 'Balwinder Kaur', 'Sahnewal', 'rejected', 1.5],
];

async function wipe() {
  await db.recursiveDelete(db.collection('config'));
  for (const c of ['kvks', 'staff', 'farmers', 'equipment', 'stock_items', 'stock_movements', 'bookings']) {
    await db.recursiveDelete(db.collection(c));
  }
  const { users } = await auth.listUsers(1000);
  if (users.length) await auth.deleteUsers(users.map((u) => u.uid));
}

async function staffUser(email, password, name, role, kvk_id) {
  const u = await auth.createUser({ email, password, displayName: name });
  await col.staff().doc(u.uid).set({ name, email, role, kvk_id, active: true, created_at: new Date().toISOString() });
  return u.uid;
}

export async function seed() {
  await wipe();
  const t0 = new Date().toISOString();
  await staffUser('admin@kvk.in', 'admin12345', 'National Admin', 'admin', null);
  await db.collection('config').doc('setup').set({ admin_uid: 'seed', at: t0 });

  let mgrLdh;
  for (const [i, [code, name, state, district, address, phone, host]] of KVKS.entries()) {
    const batch = db.batch();
    batch.set(col.kvks().doc(code), { code, name, state, district, address, phone, host_institution: host, active: true, created_at: t0 });
    const slug = district.toLowerCase().replace(/\s+/g, '');
    const mgr = await staffUser(`manager.${slug}@kvk.in`, 'manager123', `Manager ${district}`, 'manager', code);
    await staffUser(`staff.${slug}@kvk.in`, 'staff1234', `Staff ${district}`, 'staff', code);
    if (i === 0) mgrLdh = mgr;
    EQUIPMENT.forEach(([key, n, category, description, daily_rate, total_qty, max_days], j) => {
      if ((i + j) % 5 === 4 && i !== 0) return; // vary the catalogue per KVK
      batch.set(col.equipment().doc(`${code}-${key}`), { kvk_id: code, name: n, category, description, daily_rate, total_qty, max_days, active: true, holds: {}, created_at: t0 });
    });
    STOCK.forEach(([type, n, unit, q, price, reorder], j) => {
      const quantity = i === 0 ? q : Math.round((q * ((i + j) % 4)) / 2);
      const ref = col.stock().doc();
      batch.set(ref, { kvk_id: code, type, name: n, unit, quantity, price_per_unit: price, reorder_level: reorder, certified: true, active: true, updated_at: t0 });
      if (quantity > 0) batch.set(col.movements().doc(), { item_id: ref.id, kvk_id: code, change: quantity, reason: 'opening', note: null, user_id: mgr, user_name: `Manager ${district}`, created_at: t0 });
    });
    await batch.commit();
  }

  // Farmers: phone-auth users + profiles
  const farmerIds = [];
  for (const [i, [phone, name, village, status, land]] of FARMERS.entries()) {
    const u = await auth.createUser({ email: `${phone}@farmer.kvk.in`, password: 'kisan123', displayName: name });
    farmerIds.push(u.uid);
    await col.farmers().doc(u.uid).set({
      phone, name, village, district: 'Ludhiana', state: 'Punjab', kvk_id: 'PB-LDH', id_type: 'Aadhaar',
      id_last4: String(1000 + i * 1111).slice(-4), land_acres: land, status,
      status_note: status === 'rejected' ? 'Name does not match ID. Please visit the KVK with your Aadhaar card.' : null,
      verified_by: status === 'pending' ? null : mgrLdh, verified_at: status === 'pending' ? null : t0, created_at: t0,
    });
  }

  const t = todayIST();
  const eq = Object.fromEntries(EQUIPMENT.map(([key, n, cat, , rate]) => [key, { id: `PB-LDH-${key}`, name: n, category: cat, rate }]));
  const book = async (fi, key, qty, s, e, status, note = null) => {
    const ref = col.bookings().doc();
    const days = (Date.parse(e) - Date.parse(s)) / 86400000 + 1;
    const [phone, name, village] = FARMERS[fi];
    await ref.set({
      ref: ref.id.slice(0, 6).toUpperCase(), kvk_id: 'PB-LDH', kvk_name: 'KVK Ludhiana', farmer_id: farmerIds[fi], equipment_id: eq[key].id,
      equipment_name: eq[key].name, category: eq[key].category, farmer_name: name, phone, village,
      qty, start_date: s, end_date: e, status, amount: eq[key].rate * qty * days, farmer_note: note, staff_note: null,
      decided_by: status === 'requested' ? null : mgrLdh, issued_at: ['issued', 'returned'].includes(status) ? `${s}T03:30:00.000Z` : null,
      created_at: t0,
    });
    if (['approved', 'issued'].includes(status)) {
      await col.equipment().doc(eq[key].id).update({ [`holds.${ref.id}`]: { qty, s, e } });
    }
  };
  await book(0, 'happyseeder', 1, addDays(t, -1), addDays(t, 1), 'issued');
  await book(1, 'tractor', 1, addDays(t, 2), addDays(t, 3), 'approved');
  await book(0, 'tractor', 1, addDays(t, 3), addDays(t, 4), 'requested', 'Need for 5 acres wheat sowing');
  await book(1, 'sprayer', 2, t, addDays(t, 2), 'approved');
  await book(0, 'leveller', 1, addDays(t, -6), addDays(t, -5), 'returned');
  await book(1, 'rotavator', 1, addDays(t, 5), addDays(t, 6), 'requested');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    console.error('Refusing to seed: demo data is for the emulators only. Run `npm run seed` from the repo root.');
    process.exit(1);
  }
  await seed();
  console.log('Demo data loaded into the emulators.');
  process.exit(0);
}
