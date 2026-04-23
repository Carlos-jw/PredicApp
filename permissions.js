import { ROLES } from './config.js?v=4.2';
import { USER_STATUS } from './user-status.js?v=1';

/**
 * Quién resuelve qué (mantener alineado con `firestore.rules`):
 * - `status`: capitán (`pendiente` → `aprobado`) para completar perfil de publicador en su punto.
 * - `adminApproved`: super de servicio activa el acceso a datos (cuentas nuevas: false hasta aprobación).
 * La UI usa este helper; las Security Rules deben exigir el mismo criterio en lecturas sensibles.
 */

export function isAdmin(profile) {
  return profile?.role === ROLES.ADMIN;
}

export function isSubadmin(profile) {
  return profile?.role === ROLES.SUBADMIN;
}

export function isUser(profile) {
  return profile?.role === ROLES.USER;
}

/** Publicador con cuenta en espera de aprobacion del capitán (`status` en Firestore). */
export function isPendingUserApproval(profile) {
  if (!profile || profile.role !== ROLES.USER) return false;
  return profile.status === USER_STATUS.PENDIENTE;
}

/** Acceso a datos de puntos (tablero, reservas, etc.): admin y capitanes; publicadores segun adminApproved y status. */
export function canUseAppData(profile) {
  if (!profile) return false;
  if (isAdmin(profile) || isSubadmin(profile)) return true;
  if (isPendingUserApproval(profile)) return false;
  return profile.adminApproved === true;
}

export function hasPointAccess(profile, pointId) {
  if (!pointId) return false;
  if (isAdmin(profile)) return true;
  return Array.isArray(profile?.assignedPointIds) && profile.assignedPointIds.includes(pointId);
}

export function canCreateSubadmin(profile) {
  return isAdmin(profile);
}

export function canManageParticipants(profile, pointId) {
  return isAdmin(profile) || hasPointAccess(profile, pointId);
}

/**
 * @alias canManageParticipants — reservado para divergencia futura de permisos de edición.
 */
export const canEditParticipants = canManageParticipants;

export function canManageSlots(profile, pointId) {
  return isAdmin(profile) || hasPointAccess(profile, pointId);
}

/** Devuelve true si authUser es el creador de la reserva. */
export function isReservationOwner(reservation, authUser) {
  return Boolean(authUser?.uid) && reservation?.userId === authUser.uid;
}

export function canManageReservation(profile, pointId, reservation, authUser) {
  if (!reservation) return false;
  if (canManageSlots(profile, pointId)) return true;
  return isReservationOwner(reservation, authUser);
}

export function canManagePoints(profile) {
  return isAdmin(profile);
}

/**
 * Para publicadores (USER), respeta `adminApproved` y `status` igual que `canUseAppData`,
 * evitando inconsistencia con rutas que llamen este helper directamente.
 */
export function canReadPoint(profile, pointId) {
  if (isAdmin(profile)) return true;
  if (isSubadmin(profile)) return hasPointAccess(profile, pointId);
  if (isUser(profile)) return canUseAppData(profile);
  return false;
}

export function getVisiblePoints(profile, points) {
  if (isAdmin(profile) || isUser(profile)) return points;
  return points.filter((point) => hasPointAccess(profile, point.id));
}

/**
 * `profile` puede ser null (ej. admin recién autenticado sin perfil cargado aún);
 * en ese caso visiblePoints[0] actúa como fallback seguro.
 */
export function getDefaultPointId(profile, visiblePoints) {
  if (!visiblePoints.length) return '';
  if (isAdmin(profile)) return visiblePoints[0].id;

  const preferred = profile?.assignedPointIds?.find((pointId) =>
    visiblePoints.some((point) => point.id === pointId)
  );

  return preferred ?? visiblePoints[0].id;
}
