import { backend } from './firebase.js';

export const setActiveKvk = (id) => backend.setActiveKvk(id);
export const api = (path, opts) => backend(path, opts);

export const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
export const fmtDate = (d) => d ? new Date(d.slice(0, 10) + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '';
