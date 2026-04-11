// ─────────────────────────────────────────────
//  config.js  —  Fuente única de verdad
// ─────────────────────────────────────────────

export const DAYS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

export const FULL_DAY_NAMES = {
  Lun: 'Lunes', Mar: 'Martes', Mié: 'Miércoles',
  Jue: 'Jueves', Vie: 'Viernes', Sáb: 'Sábado', Dom: 'Domingo'
};

export const TIMES = [
  '07:00-09:00', '09:00-11:00', '11:00-13:00',
  '13:00-15:00', '15:00-17:00', '17:00-19:00'
];

export const MAX_RESERVATIONS_PER_SLOT = 2;

export const DEFAULT_POINTS = ['Parroquia Central', 'Plaza Norte', 'Barrio Sur'];

export const STORAGE_PREFIX = 'predicapp_';

// Hash SHA-256 de 'admin' — nunca guardes texto plano
// Para cambiar: ejecuta en consola: await hashPassword('nueva_pass')
export const DEFAULT_PASS_HASH = '8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918';
