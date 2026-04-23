export const APP_VERSION = '4.2';

export const DAYS = ['Lun', 'Mar', 'Mie', 'Jue', 'Vie', 'Sab', 'Dom'];

export const FULL_DAY_NAMES = {
  Lun: 'Lunes',
  Mar: 'Martes',
  Mie: 'Miercoles',
  Jue: 'Jueves',
  Vie: 'Viernes',
  Sab: 'Sabado',
  Dom: 'Domingo'
};

export const TIMES = [
  '07:00-09:00',
  '09:00-11:00',
  '11:00-13:00',
  '13:00-15:00',
  '15:00-17:00',
  '17:00-19:00'
];

export const MIN_RESERVATIONS_PER_SLOT = 2;
export const MAX_RESERVATIONS_PER_SLOT = 3;

export const DEFAULT_POINTS = [
  'San Martin',
  '5 y 6',
  'Familia Rua',
  'Familia Molina',
  'Salón del Reino'
];

export const ROLES = {
  ADMIN: 'admin',
  SUBADMIN: 'subadmin',
  USER: 'usuario'
};

/** Nombres mostrados en la interfaz (los valores guardados en Firestore siguen siendo admin / subadmin / usuario). */
export const ROLE_LABELS = {
  [ROLES.ADMIN]: 'Super de servicio',
  [ROLES.SUBADMIN]: 'Capitán',
  [ROLES.USER]: 'Publicador'
};

export function getRoleLabel(role) {
  const r = String(role ?? '').trim();
  if (r === ROLES.ADMIN) return ROLE_LABELS[ROLES.ADMIN];
  if (r === ROLES.SUBADMIN) return ROLE_LABELS[ROLES.SUBADMIN];
  if (r === ROLES.USER) return ROLE_LABELS[ROLES.USER];
  return r || ROLE_LABELS[ROLES.USER];
}

export const COLLECTIONS = {
  USERS: 'users',
  POINTS: 'points',
  /** Legado: ya no se usa en el flujo principal; se puede eliminar de Firestore cuando migres. */
  ALLOWED_EMAILS: 'allowed_emails'
};

/** Estado de la solicitud de turno en `slots.*.reservations[]`. */
export const RESERVATION_APPROVAL = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected'
};

/** Clave de documento en `allowed_emails` y token de Auth (Firebase suele normalizar a minusculas). */
export function normalizeAuthEmailForAllowlist(email) {
  return String(email ?? '').trim().toLowerCase();
}

export const POINT_DATA_DOCS = {
  PARTICIPANTS: 'participants',
  SLOTS: 'slots',
  REPORTS: 'reports'
};

export function normalizePointId(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || 'point';
}

export function buildDefaultSlots(pointId, pointName) {
  return DAYS.reduce((acc, day) => {
    acc[day] = TIMES.map((time) => ({
      id: `${day}-${time}`.replace(/[^A-Za-z0-9-]/g, '_'),
      day,
      time,
      pointId,
      pointName,
      status: 'free',
      reservations: []
    }));
    return acc;
  }, {});
}
