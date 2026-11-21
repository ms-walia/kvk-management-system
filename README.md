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
- **Farmers**: verification queue (check Aadhaar/land record in person, then verify or reject with a reason).
- **Staff**: managers add staff for their KVK; admins add managers and admins.

**Farmer app**
- Sign in with mobile number + SMS OTP (Firebase Phone Auth), or browse without signing in.
- Pick state → district → KVK. See every machine's availability for the next week and for chosen dates.
- See feed/fertilizer/seed stock (in stock / few left / out) and prices.
- Complete profile → KVK verifies → book machines; track and cancel bookings.

## Data & security

- Firestore collections: `kvks`, `staff`, `farmers`, `equipment`, `stock_items`, `stock_movements`, `bookings`, `config`.
- `firestore.rules` enforces everything: staff only see their own KVK; only managers edit the catalogue and prices;
  farmers can only edit their own profile and can never verify themselves; only verified farmers can create a booking,
  only as `requested`, only at their own KVK; stock can never go negative.
- No double booking: approved bookings are recorded as "holds" on the equipment document (dates and quantity only, no
  personal data), and approvals run in a Firestore transaction on that document, so two staff approving the same machine
  at the same moment cannot both succeed.
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
`staff.ludhiana@kvk.in` / `staff1234`. Farmers: any 10-digit number (verified demo farmer: `9876500001`);
the OTP shows in the emulator UI under Authentication.

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

## Deploy the web apps on Vercel (alternative to Firebase Hosting)

Firebase still provides Auth and Firestore; Vercel only serves the two built apps (`vercel.json` is included).

1. In Vercel: **Add New → Project → Import** `ms-walia/kvk-management-system`. Framework preset: **Other**
   (build command, output directory and routes come from `vercel.json`).
2. **Settings → Environment Variables** (Production and Preview), values from Firebase console → Project settings → Your apps → Web app:
   `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN` (`kvk-management-system.firebaseapp.com`),
   `VITE_FIREBASE_PROJECT_ID` (`kvk-management-system`), `VITE_FIREBASE_APP_ID`. Redeploy after adding them.
3. Firebase console → **Authentication → Settings → Authorized domains**: add your Vercel domain
   (e.g. `kvk-management-system.vercel.app`), or sign-in will fail.
4. Publish the security rules and indexes once from your Mac (Vercel does not do this):
   ```bash
   npx firebase deploy --only firestore --project kvk-management-system
   ```
   Without this step Firestore keeps its default "deny everything" rules and the apps cannot load data.
5. Open `https://<your-vercel-domain>/erp` → **Set up the national admin** → KVKs → **Load sample KVKs**.

## Next steps (not built yet)
- Bulk import of all ~730 KVKs from the ICAR list (CSV upload).
- SMS / WhatsApp notifications when a booking is approved or rejected.
- Online payment of rent (UPI) and printable receipts.
- Farmer requests for feed/fertilizer (reserve and pick up).
- More languages (Punjabi, Marathi, Tamil, Telugu, Bengali…) in `apps/farmer/src/i18n.js`.
- Reports export (Excel) for ICAR/ATARI.
- Native Android app on the same API.
