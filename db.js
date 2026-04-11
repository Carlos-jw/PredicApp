// ─────────────────────────────────────────────
//  db.js  —  Capa de almacenamiento
//  Mejoras: try/catch, DRY, ES Modules,
//           sin acceso directo a localStorage fuera de aquí
// ─────────────────────────────────────────────

import { STORAGE_PREFIX, DAYS, TIMES, DEFAULT_POINTS } from './config.js';

// ── Utilidad interna ──────────────────────────────────────────
function storageKey(key) {
  return `${STORAGE_PREFIX}${key}`;
}

function safeParse(raw, fallback) {
  try {
    return raw !== null ? JSON.parse(raw) : fallback;
  } catch (e) {
    console.warn(`[DB] JSON corrupto para la clave "${raw}":`, e);
    return fallback;
  }
}

function safeWrite(key, value) {
  try {
    localStorage.setItem(storageKey(key), JSON.stringify(value));
    return true;
  } catch (e) {
    // QuotaExceededError u otros errores de storage
    console.error(`[DB] Error al escribir "${key}":`, e);
    return false;
  }
}

// ── API pública ───────────────────────────────────────────────
export const DB = {
  /**
   * Lee un valor. Devuelve `fallback` si no existe o está corrupto.
   * @param {string} key
   * @param {*} fallback  — valor por defecto ([] para arrays, {} para objetos)
   */
  get(key, fallback = []) {
    const raw = localStorage.getItem(storageKey(key));
    return safeParse(raw, fallback);
  },

  /**
   * Guarda un valor. Devuelve true si tuvo éxito.
   * @param {string} key
   * @param {*} value
   */
  set(key, value) {
    return safeWrite(key, value);
  },

  /**
   * Elimina una clave.
   */
  remove(key) {
    localStorage.removeItem(storageKey(key));
  },

  /**
   * Verifica si una clave existe.
   */
  has(key) {
    return localStorage.getItem(storageKey(key)) !== null;
  }
};

// ── Inicialización de datos por defecto ───────────────────────
export function initDB() {
  if (!DB.has('points')) {
    DB.set('points', DEFAULT_POINTS);
  }

  if (!DB.has('slots')) {
    const slots = {};
    DAYS.forEach(d => {
      slots[d] = TIMES.map(t => ({
        id: `${d}-${t}`,
        time: t,
        status: 'free',
        reservations: []
      }));
    });
    DB.set('slots', slots);
  }

  if (!DB.has('participants')) {
    DB.set('participants', []);
  }
}
