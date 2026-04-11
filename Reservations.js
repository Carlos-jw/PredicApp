// ─────────────────────────────────────────────
//  reservations.js  —  Lógica de negocio
//  Mejoras: validaciones, sin duplicados,
//           separación controller/model,
//           funciones puras y testeables
// ─────────────────────────────────────────────

import { MAX_RESERVATIONS_PER_SLOT } from './config.js';

/**
 * Calcula el status de un slot según sus reservas.
 * @param {Object} slot
 * @returns {'free'|'partial'|'full'}
 */
export function computeStatus(slot) {
  const count = slot.reservations.length;
  if (count === 0) return 'free';
  if (count >= MAX_RESERVATIONS_PER_SLOT) return 'full';
  return 'partial';
}

/**
 * Valida si una reserva puede agregarse.
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateReservation(slot, name, point) {
  if (!name || !point) {
    return { ok: false, error: 'Debes seleccionar participante y punto.' };
  }

  if (slot.reservations.length >= MAX_RESERVATIONS_PER_SLOT) {
    return { ok: false, error: 'Este turno ya está completo.' };
  }

  // Evitar que la misma persona reserve el mismo turno dos veces
  const alreadyBooked = slot.reservations.some(r => r.name === name);
  if (alreadyBooked) {
    return { ok: false, error: `${name} ya tiene una reserva en este turno.` };
  }

  return { ok: true };
}

/**
 * Agrega una reserva a un slot (muta el slot y retorna el estado actualizado).
 * Llama a validateReservation antes de mutar.
 * @returns {{ ok: boolean, error?: string }}
 */
export function addReservation(slot, name, point) {
  const validation = validateReservation(slot, name, point);
  if (!validation.ok) return validation;

  slot.reservations.push({ name, point });
  slot.status = computeStatus(slot);
  return { ok: true };
}

/**
 * Elimina una reserva de un slot por nombre.
 * @returns {{ ok: boolean, error?: string }}
 */
export function removeReservation(slot, name) {
  const idx = slot.reservations.findIndex(r => r.name === name);
  if (idx === -1) return { ok: false, error: 'Reserva no encontrada.' };

  slot.reservations.splice(idx, 1);
  slot.status = computeStatus(slot);
  return { ok: true };
}
