import { MAX_RESERVATIONS_PER_SLOT, RESERVATION_APPROVAL } from './config.js?v=4.2';

/** Un cupo libre antes de completar (p. ej. 2/3). */
function isOneSeatBeforeFull(n) {
  return MAX_RESERVATIONS_PER_SLOT > 1 && n === MAX_RESERVATIONS_PER_SLOT - 1;
}

/** Sin campo o `approved`: cuenta como confirmada (datos anteriores a solicitudes pendientes). */
export function isReservationApproved(r) {
  const s = r?.approvalStatus;
  if (s === undefined || s === null || s === '') return true;
  return s === RESERVATION_APPROVAL.APPROVED;
}

export function isReservationPending(r) {
  return r?.approvalStatus === RESERVATION_APPROVAL.PENDING;
}

export function isReservationRejected(r) {
  return r?.approvalStatus === RESERVATION_APPROVAL.REJECTED;
}

function activeReservations(slot) {
  return (slot.reservations ?? []).filter((r) => !isReservationRejected(r));
}

/** Misma idea que nombres de participantes en Firestore: trim + minusculas (sin colapsar espacios internos). */
function normalizeReservationName(value) {
  return String(value ?? '').trim().toLowerCase();
}

/** Cupos del turno: solo reservas aprobadas (visibles como cupo lleno en tablero). */
export function countPeople(slot) {
  const list = (slot.reservations ?? []).filter(isReservationApproved);
  return list.reduce((sum, r) => sum + 1 + (r.companions?.length ?? 0), 0);
}

export function countPendingRequests(slot) {
  return (slot.reservations ?? []).filter(isReservationPending).length;
}

export function getPendingReservations(slot) {
  return (slot.reservations ?? []).filter(isReservationPending);
}

export function computeStatus(slot) {
  const n = countPeople(slot);
  if (n === 0) return 'free';
  if (n >= MAX_RESERVATIONS_PER_SLOT) return 'complete';
  if (isOneSeatBeforeFull(n)) return 'ready';
  return 'partial';
}

/**
 * @param {object} slot
 * @param {boolean} [onlyApproved=true] nombres para tablero público; false incluye pendientes (capitán).
 */
export function getPeopleNames(slot, onlyApproved = true) {
  const names = new Set();
  const list = onlyApproved
    ? (slot.reservations ?? []).filter(isReservationApproved)
    : activeReservations(slot);
  list.forEach((r) => {
    names.add(r.name);
    r.companions?.forEach((c) => names.add(c));
  });
  return [...names];
}

export function getSlotPoint(slot) {
  const first = (slot.reservations ?? []).find(isReservationApproved);
  return first?.point ?? '';
}

function normalizeUserId(value) {
  return String(value ?? '').trim();
}

function normalizePointId(value) {
  return String(value ?? '').trim();
}

export function getUserReservationsAcrossPoints(uid, pointSources = []) {
  const cleanUid = normalizeUserId(uid);
  if (!cleanUid) return [];

  const reservations = [];
  const sources = Array.isArray(pointSources) ? pointSources : [];

  sources.forEach((source) => {
    const pointId = normalizePointId(source?.pointId ?? source?.id);
    const pointName = String(source?.pointName ?? source?.name ?? '').trim();
    const subadminId = normalizeUserId(source?.subadminId);
    const subadminName = String(source?.subadminName ?? '').trim();
    const slots = source?.slots ?? {};

    Object.entries(slots).forEach(([day, daySlots]) => {
      if (!Array.isArray(daySlots)) return;

      daySlots.forEach((slot) => {
        const time = String(slot?.time ?? '').trim();
        const slotPointId = normalizePointId(slot?.pointId) || pointId;
        const slotPointName = String(slot?.pointName ?? pointName).trim();

        (slot?.reservations ?? []).forEach((reservation) => {
          if (normalizeUserId(reservation?.userId) !== cleanUid) return;
          if (isReservationRejected(reservation)) return;

          reservations.push({
            uid: cleanUid,
            day: String(day ?? '').trim(),
            time,
            pointId: normalizePointId(reservation?.pointId) || slotPointId,
            pointName: String(reservation?.point ?? slotPointName).trim(),
            subadminId: normalizeUserId(reservation?.assignedSubadminId) || subadminId,
            subadminName: String(reservation?.assignedSubadminName ?? subadminName).trim(),
            name: String(reservation?.name ?? '').trim(),
            companions: Array.isArray(reservation?.companions)
              ? reservation.companions.filter((item) => item && String(item).trim() !== '')
              : [],
            approvalStatus: reservation?.approvalStatus ?? RESERVATION_APPROVAL.APPROVED
          });
        });
      });
    });
  });

  return reservations;
}

/**
 * Reglas: mismo punto → ok. Otro punto + mismo día/hora → blocked.
 * Otro punto + horario distinto → warn (reasignación).
 *
 * @param {Array} existingReservations
 * @param {string} newDay
 * @param {string} newTime
 * @param {string} newPointId
 * @param {{ pointName?: string, subadminName?: string }} [newPointMeta] metadatos del punto destino (opcional)
 * @returns {{ status: 'ok' }} | {{ status: 'blocked', reason: string, conflictingSlot: { day: string, time: string, pointId: string } }} | {{ status: 'warn', action: string, from: object, to: object, affectedReservations: Array }}
 */
export function detectConflict(existingReservations, newDay, newTime, newPointId, newPointMeta = {}) {
  const reservations = Array.isArray(existingReservations) ? existingReservations : [];
  const cleanPointId = normalizePointId(newPointId);
  const dayNorm = String(newDay ?? '').trim();
  const timeNorm = String(newTime ?? '').trim();

  const crossPointReservations = reservations.filter((reservation) => {
    const pid = normalizePointId(reservation?.pointId);
    return Boolean(pid) && pid !== cleanPointId;
  });

  if (!crossPointReservations.length) {
    return { status: 'ok' };
  }

  const conflicting = crossPointReservations.find(
    (reservation) =>
      String(reservation?.day ?? '').trim() === dayNorm &&
      String(reservation?.time ?? '').trim() === timeNorm
  );

  if (conflicting) {
    return {
      status: 'blocked',
      reason: 'conflict',
      conflictingSlot: {
        day: String(conflicting.day ?? '').trim(),
        time: String(conflicting.time ?? '').trim(),
        pointId: normalizePointId(conflicting.pointId)
      }
    };
  }

  const affectedReservations = crossPointReservations.map((reservation) => ({
    day: String(reservation?.day ?? '').trim(),
    time: String(reservation?.time ?? '').trim(),
    pointId: normalizePointId(reservation?.pointId),
    pointName: String(reservation?.pointName ?? '').trim(),
    subadminId: normalizeUserId(reservation?.subadminId),
    subadminName: String(reservation?.subadminName ?? '').trim()
  }));

  const fromSource = affectedReservations[0] ?? null;

  return {
    status: 'warn',
    action: 'reassign',
    from: {
      pointId: fromSource?.pointId ?? '',
      pointName: fromSource?.pointName ?? '',
      subadminName: fromSource?.subadminName ?? ''
    },
    to: {
      pointId: cleanPointId,
      pointName: String(newPointMeta?.pointName ?? '').trim(),
      subadminName: String(newPointMeta?.subadminName ?? '').trim()
    },
    affectedReservations
  };
}

export function validateReservation(slot, name, point, companions = []) {
  if (!slot || !Array.isArray(slot.reservations)) {
    return { ok: false, error: 'Turno invalido.' };
  }
  if (!name || !point) {
    return { ok: false, error: 'Debes seleccionar participante y punto.' };
  }

  const normMain = normalizeReservationName(name);
  const valid = companions.filter((c) => c && c !== '');
  const normCompanions = valid.map((c) => normalizeReservationName(c));

  if (valid.length > 2) return { ok: false, error: 'Maximo dos companeros por reserva.' };
  if (normCompanions.some((nc) => nc && nc === normMain)) {
    return { ok: false, error: 'Un companero no puede ser el mismo que el participante principal.' };
  }
  if (normCompanions.length === 2 && normCompanions[0] && normCompanions[0] === normCompanions[1]) {
    return { ok: false, error: 'Los dos companeros no pueden ser la misma persona.' };
  }

  const current = countPeople(slot);
  const incoming = 1 + valid.length;

  if (current + incoming > MAX_RESERVATIONS_PER_SLOT) {
    return { ok: false, error: 'Solo quedan ' + (MAX_RESERVATIONS_PER_SLOT - current) + ' cupo(s).' };
  }

  const resList = activeReservations(slot);
  if (resList.some((r) => normalizeReservationName(r.name) === normMain)) {
    return { ok: false, error: name + ' ya esta en este turno.' };
  }
  if (resList.some((r) => (r.companions ?? []).some((c) => normalizeReservationName(c) === normMain))) {
    return { ok: false, error: name + ' ya participa en este turno como companero.' };
  }

  for (let i = 0; i < valid.length; i += 1) {
    const nc = normCompanions[i];
    const used = resList.some(
      (r) => normalizeReservationName(r.name) === nc
        || (r.companions ?? []).some((c) => normalizeReservationName(c) === nc)
    );
    if (used) return { ok: false, error: valid[i] + ' ya participa en este turno.' };
  }

  return { ok: true, companions: valid };
}


export function upsertReservationForUser(slot, {
  userId,
  pointId = '',
  name,
  point,
  companions = [],
  assignedSubadminId = '',
  assignedSubadminName = '',
  approvalStatus = RESERVATION_APPROVAL.PENDING
}) {
  if (!slot || !Array.isArray(slot.reservations)) {
    return { ok: false, error: 'Estructura de turno invalida.' };
  }
  if (!userId) {
    return { ok: false, error: 'Usuario invalido para reservar.' };
  }

  const existingIndex = slot.reservations.findIndex((reservation) => reservation.userId === userId);
  let previous = null;

  if (existingIndex !== -1) {
    previous = slot.reservations[existingIndex];
    slot.reservations.splice(existingIndex, 1);
  }

  const validation = validateReservation(slot, name, point, companions);
  if (!validation.ok) {
    if (previous) slot.reservations.splice(existingIndex, 0, previous);
    slot.status = computeStatus(slot);
    return validation;
  }

  slot.reservations.push({
    userId,
    pointId,
    name,
    point,
    companions: validation.companions,
    assignedSubadminId,
    assignedSubadminName,
    approvalStatus
  });
  slot.status = computeStatus(slot);
  return { ok: true, mode: previous ? 'updated' : 'created' };
}

export function removeReservationByUser(slot, userId) {
  const idx = slot.reservations.findIndex((reservation) => reservation.userId === userId);
  if (idx === -1) return { ok: false, error: 'No tienes una reserva en este turno.' };
  slot.reservations.splice(idx, 1);
  slot.status = computeStatus(slot);
  return { ok: true };
}

export function removeReservation(slot, name) {
  const normTarget = normalizeReservationName(name);
  const idx = slot.reservations.findIndex(
    (r) => normalizeReservationName(r.name) === normTarget
  );
  if (idx === -1) return { ok: false, error: 'Reserva no encontrada.' };

  slot.reservations.splice(idx, 1);
  slot.status = computeStatus(slot);
  return { ok: true };
}

export function cancelSlot(slot) {
  slot.reservations = [];
  slot.status = 'free';
  return { ok: true };
}
