# KVK Management System

An ERP for Krishi Vigyan Kendras (KVKs) and a farmer app for booking KVK farm machinery, built on Firebase.

| Part | Who uses it | URL when deployed |
|---|---|---|
| **KVK ERP** (`apps/erp`) | KVK managers & staff, national admins | `https://kvk-management-system.web.app/erp` |
| **KVK Kisan farmer app** (`apps/farmer`) | Farmers, on any phone (installable PWA, Hindi/English) | `https://kvk-management-system.web.app/` |

Runs on the **free Spark plan**: Firebase Hosting + Authentication + Firestore only (no Cloud Functions).
Both apps use the same data layer, `shared/backend.js`, which talks to Firestore directly.
`firestore.rules` is the real access control.

## What it does

**KVK ERP**
- Dashboard per KVK: requests to review, farmers to verify, machines out, overdue returns, pickups/returns due, low stock, monthly rental income.
- National admin view across all KVKs, with a KVK switcher; add/edit KVKs (700+ supported).
- **Equipment**: catalogue with daily rent, units owned, max days per booking; 14-day availability calendar per machine.
- **Bookings**: approve (capacity checked, no double booking even if two staff click at once), reject with reason, hand over, mark returned with condition. Early returns free up remaining days.
- **Feeds, fertilizers, seeds**: stock levels with reorder alerts; receive/issue/write-off with a full movement log.
- **Trainings**: managers and admins publish training programmes for their KVK straight away; staff propose
  trainings, which a manager approves or sends back with a note (shown on the dashboard and in a Proposals tab).
  Each training (agriculture, horticulture, animal husbandry, student programmes…) has dates, daily timing, last date to apply, seats, fee, venue, the "how to apply"
  steps, the documents to bring, and the application form (upload a PDF/Word/photo up to 700 KB, or paste a link).
- **Farmers**: verification queue (check Aadhaar/land record in person, then verify or reject with a reason).
- **Staff**: managers add staff for their KVK; admins add managers and admins.

**Farmer app**
- Sign in or create an account with mobile number + password (no OTP needed), or browse without signing in.
  Behind the scenes the number is stored as a Firebase email login `<number>@farmer.kvk.in`.
- Pick state → district → KVK. See every machine's availability for the next week and for chosen dates.
- See feed/fertilizer/seed stock (in stock / few left / out) and prices.
- Complete profile → KVK verifies → book machines; track and cancel bookings.
- **Trainings** (no sign-in needed): upcoming trainings at the KVK with timings and last date to apply. Each one shows
  how to apply, the documents needed, and a button to download the application form. Registration itself happens in
  person at the KVK office.

## Data & security

- Firestore collections: `kvks`, `staff`, `farmers`, `equipment`, `stock_items`, `stock_movements`, `bookings`, `trainings`, `training_forms`, `config`.
- `firestore.rules` enforces everything: staff only see their own KVK; only managers edit the catalogue and prices;
  farmers can only edit their own profile and can never verify themselves; only verified farmers can create a booking,
  only as `requested`, only at their own KVK; stock can never go negative.
- No double booking: approved bookings are recorded as "holds" on the equipment document (dates and quantity only, no
  personal data), and approvals run in a Firestore transaction on that document, so two staff approving the same machine
  at the same moment cannot both succeed.
- Training application forms: the free Spark plan has no Cloud Storage bucket, so an uploaded form is stored
  base64-encoded in its own Firestore document `training_forms/{trainingId}` (one per training, max 700 KB file so it
  stays under Firestore's 1 MiB document limit). The training list never loads these, only the Download button does.
  Bigger forms can be given as a link (Google Drive etc.). A sample form ships at `/forms/kvk-training-application-form.pdf`.
- Roles: `admin` (national), `manager` (one KVK, edits catalogue and staff), `staff` (one KVK, day-to-day operations).
- First admin: on a fresh project the ERP sign-in page offers "Set up the national admin" once; the rules lock it after that.

## Run locally (Firebase emulators, no cloud needed)

Requirements: Node 22+, Java 11+ (for the Firestore emulator).

```bash
npm install
npm run emulators          # terminal 1: Auth + Firestore emulators (UI at http://127.0.0.1:4001)
npm run seed               # terminal 2: demo data (10 KVKs, equipment, stock, farmers, bookings, staff logins)
npm run dev:erp            # http://localhost:5173/erp/
npm run dev:farmer         # http://localhost:5174/
npm test                   # 10 tests of the data layer AND the security rules, against the emulators
```

Demo logins (emulator only): `admin@kvk.in` / `admin12345`, `manager.ludhiana@kvk.in` / `manager123`,
`staff.ludhiana@kvk.in` / `staff1234`. Farmers: mobile `9876500001` (verified) or `9876500003` (pending) with the emulator seed password in `scripts/seed.js`.

## Deploy to `kvk-management-system` (Spark plan)

Console setup (done): Email/Password and Phone sign-in on, Firestore in `asia-south2` (Delhi),
test phone numbers added under Authentication → Sign-in method → Phone. On Spark, real SMS OTPs are not sent;
farmers sign in with the test numbers and their fixed codes. Moving to Blaze later enables real SMS with no code change.

1. Register a web app and put its config in `apps/erp/.env.production` and `apps/farmer/.env.production`
   (see the `.env.production.example` files):
   ```bash
   firebase apps:create web "KVK web" --project kvk-management-system
   firebase apps:sdkconfig web --project kvk-management-system
   ```
2. Deploy hosting + Firestore rules and indexes:
   ```bash
   npm run deploy
   ```
3. Open `https://kvk-management-system.web.app/erp`, click **Set up the national admin**, then on the KVKs page click
   **Load sample KVKs** (or add real ones), open a KVK and add its manager under Staff.

## Demo accounts in the real project

After the rules are deployed, create demo logins and sample data (safe to re-run). Passwords are given on the
command line and are not stored in the repo:
```bash
FIREBASE_API_KEY=<web api key> FIREBASE_PROJECT_ID=kvk-management-system \
ADMIN_PASSWORD=... STAFF_PASSWORD=... FARMER_PASSWORD=... node scripts/create-demo-accounts.js
```
Creates: national admin `admin@kvk.in`; managers `manager.ludhiana@kvk.in`, `manager.karnal@kvk.in`,
`manager.baramati@kvk.in`; staff `staff.ludhiana@kvk.in`; farmers (mobile number logins) `9876500001`, `9876500002`
(verified, Ludhiana), `9876500003` (awaiting verification, Ludhiana), `9876500011` (verified, Karnal); a few bookings.

## Deploy the web apps on Vercel

Zero configuration: in Vercel, **Add New → Project → Import** `ms-walia/kvk-management-system` and press **Deploy**.
`vercel.json` sets the build, and the public Firebase web config for `kvk-management-system` is built into the apps
(`apps/*/src/firebase.js`; `VITE_FIREBASE_*` env vars override it if you ever point at another project).
The farmer app is served at `/` and the ERP at `/erp`. Email/password sign-in works on any domain, so no Firebase
console change is needed. If you change `firestore.rules`, publish them with
`npx firebase deploy --only firestore --project kvk-management-system`.

## Next steps (not built yet)
- Bulk import of all ~730 KVKs from the ICAR list (CSV upload).
- SMS / WhatsApp notifications when a booking is approved or rejected.
- Online payment of rent (UPI) and printable receipts.
- Farmer requests for feed/fertilizer (reserve and pick up).
- More languages (Punjabi, Marathi, Tamil, Telugu, Bengali…) in `apps/farmer/src/i18n.js`.
- Reports export (Excel) for ICAR/ATARI.
- Native Android app on the same API.
