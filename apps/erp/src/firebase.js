import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore';
import { createBackend } from '../../../shared/backend.js';

// `npm run dev` uses the local emulators; production builds use the real project below.
const env = import.meta.env;
export const USE_EMULATOR = env.DEV && env.VITE_USE_PROD !== 'true';

// Public Firebase web config for kvk-management-system (safe to ship in client code;
// access is controlled by firestore.rules). Env vars override it if set.
const PROD = {
  apiKey: 'AIzaSyD-B6mVcYtrFJo4RaGcUPgSgueP-NYSpII',
  authDomain: 'kvk-management-system.firebaseapp.com',
  projectId: 'kvk-management-system',
  appId: '1:413218415734:web:bd6d089d2b2bdd17b9ab57',
};
const EMULATOR = { apiKey: 'demo-key', authDomain: 'demo-kvk.firebaseapp.com', projectId: 'demo-kvk' };
const base = USE_EMULATOR ? EMULATOR : PROD;

const app = initializeApp({
  apiKey: env.VITE_FIREBASE_API_KEY || base.apiKey,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || base.authDomain,
  projectId: env.VITE_FIREBASE_PROJECT_ID || base.projectId,
  appId: env.VITE_FIREBASE_APP_ID || base.appId,
});
export const auth = getAuth(app);
if (USE_EMULATOR) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(getFirestore(app), '127.0.0.1', 8080);
  auth.settings.appVerificationDisabledForTesting = true; // no real reCAPTCHA against the emulator
}
export const backend = createBackend(app);
