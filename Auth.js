// ─────────────────────────────────────────────
//  auth.js  —  Autenticación segura
//  Mejoras: hash SHA-256 via Web Crypto API,
//           sin contraseñas en texto plano,
//           sin prompt() bloqueante
// ─────────────────────────────────────────────

import { DB } from './db.js';
import { DEFAULT_PASS_HASH } from './config.js';

const PASS_KEY = 'admin_pass_hash';

/**
 * Genera hash SHA-256 de una cadena.
 * Usa la Web Crypto API nativa del navegador (sin dependencias).
 * @param {string} text
 * @returns {Promise<string>} hex string
 */
export async function hashPassword(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Obtiene el hash guardado o el hash por defecto.
 */
function getStoredHash() {
  return DB.get('admin_pass_hash', null) || DEFAULT_PASS_HASH;
}

/**
 * Verifica si la contraseña ingresada es correcta.
 * @param {string} inputPassword
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(inputPassword) {
  const inputHash = await hashPassword(inputPassword);
  return inputHash === getStoredHash();
}

/**
 * Cambia la contraseña del administrador.
 * @param {string} oldPassword
 * @param {string} newPassword
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function changePassword(oldPassword, newPassword) {
  if (!await verifyPassword(oldPassword)) {
    return { ok: false, error: 'Contraseña actual incorrecta' };
  }
  if (newPassword.length < 6) {
    return { ok: false, error: 'La nueva contraseña debe tener al menos 6 caracteres' };
  }
  const newHash = await hashPassword(newPassword);
  DB.set('admin_pass_hash', newHash);
  return { ok: true };
}
