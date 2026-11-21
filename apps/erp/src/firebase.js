import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore';
import { createBackend } from '../../../shared/backend.js';

// Values come from .env.production (real project) or fall back to the local emulators.
const env = import.meta.env;
export const USE_EMULATOR = env.DEV && env.VITE_USE_PROD !== 'true';

const app = initializeApp({
  apiKey: env.VITE_FIREBASE_API_KEY || 'demo-key',
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || 'demo-kvk.firebaseapp.com',
  projectId: env.VITE_FIREBASE_PROJECT_ID || 'demo-kvk',
  appId: env.VITE_FIREBASE_APP_ID,
});
export const auth = getAuth(app);
if (USE_EMULATOR) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(getFirestore(app), '127.0.0.1', 8080);
  auth.settings.appVerificationDisabledForTesting = true; // no real reCAPTCHA against the emulator
}
export const backend = createBackend(app);
