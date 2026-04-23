import { observeSession, logout, signIn, signInWithGoogle } from './auth.js';
import {
  DAYS,
  MAX_RESERVATIONS_PER_SLOT,
  RESERVATION_APPROVAL,
  ROLES,
  TIMES,
  getRoleLabel,
  normalizeAuthEmailForAllowlist,
  normalizePointId
} from './config.js?v=4.2';
import { USER_STATUS } from './user-status.js?v=1';
import { DB, auth, onConnectionChange } from './db.js';
import {
  canCreateSubadmin,
  canEditParticipants,
  canManageReservation,
  canManagePoints,
  canManageSlots,
  canUseAppData,
  getDefaultPointId,
  getVisiblePoints,
  isAdmin,
  isPendingUserApproval,
  isSubadmin
} from './permissions.js';
import {
  cancelSlot,
  countPeople,
  detectConflict,
  getPeopleNames,
  removeReservation
} from './reservations.js';
import { generatePDF } from './reports.js';
import { confirm, promptInput, toast } from './toast.js';
import { UI } from './ui.js';
 
/** Evita transacciones repetidas si el snapshot de slots llega varias veces seguidas vacio. */
const ensureDefaultSlotsInflight = new Set();

const state = {
  authUser: null,
  profile: null,
  points: [],
  visiblePoints: [],
  selectedPointId: '',
  participants: [],
  participantsDirectory: [],
  participantQuery: '',
  selectedDirectoryParticipantId: '',
  pendingReserveParticipantName: '',
  slots: {},
  reports: [],
  users: [],
  canCancelOwnReservation: false,
  currentView: 'home',
  enrollPoints: [],
  /** Solo capitán: lista en tiempo real de publicadores pendientes en sus puntos. */
  pendingUsersCaptain: []
};

/** Tras cambiar de punto desde Inicio, navegar cuando llegue el primer snapshot de datos (evita setTimeout fijo). */
let pendingHomeDestination = '';

let renderQueued = false;
let renderDirty = false;

const VIEW_TITLES = {
  home: 'Inicio',
  board: 'Tablero',
  reserve: 'Reservar',
  'my-reservations': 'Mis reservas',
  people: 'Participantes',
  admin: 'Super de servicio',
  profile: 'Perfil'
};

function getAppMode() {
  if (!state.authUser) return 'guest';
  if (isAdmin(state.profile)) return 'admin';
  if (isSubadmin(state.profile)) return 'subadmin';
  return 'user';
}

function activateAppView(view) {
  const targetId = `view-${view}`;
  const target = document.getElementById(targetId);
  const safeView = target ? view : 'home';

  document.querySelectorAll('.nav-tab[data-view]').forEach((item) => {
    const on = item.dataset.view === safeView;
    item.classList.toggle('active', on);
    item.setAttribute('aria-selected', String(on));
  });

  document.querySelectorAll('.view-main').forEach((el) => {
    el.style.display = 'none';
  });
  const main = document.getElementById(`view-${safeView}`);
  if (main) main.style.display = '';

  let title = VIEW_TITLES[safeView] ?? safeView;
  if (safeView === 'board' && isSubadmin(state.profile)) {
    title = 'Horarios';
  }
  setText('workspace-title', title);
  state.currentView = safeView;

  if (safeView === 'my-reservations' && state.authUser) {
    loadMyReservationsList();
  }
}

function canUseAppDataProfile() {
  return canUseAppData(state.profile);
}

/** True si falta al menos un dia de la grilla estandar (doc ausente, vacio o incompleto). */
function slotGridNeedsBackfill(slots) {
  return DAYS.some((day) => !Array.isArray(slots?.[day]) || slots[day].length === 0);
}

function maybeEnsureDefaultSlotsForSelectedPoint() {
  const pointId = state.selectedPointId;
  if (!pointId || !canUseAppDataProfile() || !canManageSlots(state.profile, pointId)) return;
  if (!slotGridNeedsBackfill(state.slots)) return;
  if (ensureDefaultSlotsInflight.has(pointId)) return;

  const point =
    state.visiblePoints.find((p) => p.id === pointId)
    ?? state.points.find((p) => p.id === pointId);

  ensureDefaultSlotsInflight.add(pointId);
  void DB.ensureDefaultSlotsIfMissing(pointId, point?.name ?? '')
    .then((result) => {
      if (result?.seeded) {
        toast('Se generaron los turnos por defecto para este punto.', 'success');
      }
    })
    .catch((err) => {
      console.warn('maybeEnsureDefaultSlotsForSelectedPoint', err);
    })
    .finally(() => {
      ensureDefaultSlotsInflight.delete(pointId);
    });
}

function applyAppChrome() {
  document.body.dataset.appMode = getAppMode();
  const guest = !state.authUser;
  document.querySelectorAll('.nav-tab[data-auth-required]').forEach((tab) => {
    if (guest) {
      tab.style.display = 'none';
      return;
    }
    const needsAccess = tab.hasAttribute('data-requires-access');
    tab.style.display = !needsAccess || canUseAppDataProfile() ? '' : 'none';
  });
  const showAdmin = Boolean(
    state.authUser && (canManagePoints(state.profile) || canCreateSubadmin(state.profile))
  );
  document.querySelectorAll('.nav-tab[data-view="admin"]').forEach((tab) => {
    tab.style.display = showAdmin ? '' : 'none';
  });
  document.querySelectorAll('.nav-tab__txt[data-label-subadmin]').forEach((el) => {
    const useSub = isSubadmin(state.profile);
    const def = el.getAttribute('data-label-default') || '';
    const sub = el.getAttribute('data-label-subadmin') || def;
    el.textContent = useSub ? sub : def;
  });
}

async function loadMyReservationsList() {
  const list = document.getElementById('my-reservations-list');
  if (!list || !state.authUser) return;
  if (!canUseAppDataProfile()) {
    list.innerHTML = '<li class="res-meta">Cuando el super active tu cuenta podras ver tus reservas aqui.</li>';
    return;
  }
  list.innerHTML = '<li>Cargando…</li>';
  try {
    const rows = await DB.getUserReservationsAcrossPoints(state.authUser.uid);
    if (!rows.length) {
      list.innerHTML = '<li class="res-meta">No tienes reservas en los puntos consultados.</li>';
      return;
    }
    list.innerHTML = '';
    rows.forEach((r) => {
      const li = document.createElement('li');
      const title = document.createElement('div');
      const pend =
        r.approvalStatus === RESERVATION_APPROVAL.PENDING
          ? ' · pendiente de capitán'
          : '';
      title.textContent = `${r.day} ${r.time} · ${r.pointName || r.pointId}${pend}`;
      li.appendChild(title);
      if (r.name) {
        const meta = document.createElement('span');
        meta.className = 'res-meta';
        meta.textContent = `Participante: ${r.name}`;
        li.appendChild(meta);
      }
      list.appendChild(li);
    });
  } catch (error) {
    console.error(error);
    list.innerHTML = '<li class="res-meta">No se pudieron cargar las reservas.</li>';
  }
}

function renderProfilePanel() {
  const av = document.getElementById('profile-avatar-initials');
  const nameEl = document.getElementById('profile-display-name');
  const emailEl = document.getElementById('profile-email');
  const pill = document.getElementById('profile-status-pill');
  const roleEl = document.getElementById('profile-role-detail');
  const pointEl = document.getElementById('profile-assigned-point');
  const subEl = document.getElementById('profile-subadmin');

  if (!state.authUser || !state.profile) {
    if (av) av.textContent = '?';
    if (nameEl) nameEl.textContent = 'Sin sesion';
    if (emailEl) emailEl.textContent = 'Inicia sesion para ver tu perfil.';
    if (pill) {
      pill.textContent = 'Participante';
      pill.style.background = 'rgba(113, 128, 150, 0.15)';
      pill.style.color = '#718096';
    }
    if (roleEl) roleEl.textContent = '—';
    if (pointEl) pointEl.textContent = '—';
    if (subEl) subEl.textContent = '—';
    return;
  }

  const display = String(state.profile.displayName ?? '').trim() || state.authUser.email || 'Usuario';
  const initials = display
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || display.slice(0, 2).toUpperCase();

  if (av) av.textContent = initials;
  if (nameEl) nameEl.textContent = display;
  if (emailEl) emailEl.textContent = state.authUser.email ?? '';

  if (pill) {
    if (!canUseAppDataProfile()) {
      pill.textContent = 'Pendiente de aprobacion';
      pill.style.background = 'rgba(183, 129, 0, 0.15)';
      pill.style.color = '#8a6d00';
    } else {
      pill.textContent = 'Sesion activa';
      pill.style.background = 'rgba(46, 125, 50, 0.12)';
      pill.style.color = '#2e7d32';
    }
  }

  if (roleEl) roleEl.textContent = getRoleLabel(state.profile.role);

  const ap = String(state.profile.assignedPointName ?? '').trim();
  if (pointEl) pointEl.textContent = ap || 'Sin asignar aun';

  const sn = String(state.profile.assignedSubadminName ?? '').trim();
  if (subEl) subEl.textContent = sn || '—';
}
 
let unsubProfile = null;
let unsubPoints = null;
let unsubPointData = null;
let unsubUsers = null;
let unsubParticipantsDirectory = null;
let unsubPendingUsers = null;
let reassignModalResolver = null;
 
document.addEventListener('DOMContentLoaded', async () => {
  setupConnectionBadge();
  setupNav();
  setupModals();
  setupReassignModal();
  setupAuth();
  setupEnrollForm();
  setupCompleteFirstPoint();
  setupProfileGuestNav();
  setupHome();
  setupPointFilter();
  setupReserveForm();
  setupParticipants();
  setupAdmin();
  setupReports();
  hydrateEnrollTimeSelect();
  hydrateDayTimeSelects();
  registerServiceWorker();
  activateAppView('home');
  await refreshEnrollPointOptions();
  render();
});

function setupAuth() {
  observeSession(async (user) => {
    state.authUser = user;
 
    unsubProfile?.();
    unsubProfile = null;
 
    if (!user) {
      unsubPoints?.();
      unsubPoints = null;
      unsubUsers?.();
      unsubUsers = null;
      unsubParticipantsDirectory?.();
      unsubParticipantsDirectory = null;
      unsubPointData?.();
      unsubPointData = null;
      state.profile = null;
      state.points = [];
      state.visiblePoints = [];
      state.selectedPointId = '';
      refreshEnrollPointOptions({ silentToast: true }).catch(() => {});
      state.participants = [];
      state.participantsDirectory = [];
      state.selectedDirectoryParticipantId = '';
      state.participantQuery = '';
      state.pendingReserveParticipantName = '';
      state.canCancelOwnReservation = false;
      state.slots = {};
      state.reports = [];
      state.users = [];
      state.pendingUsersCaptain = [];
      unsubPendingUsers?.();
      unsubPendingUsers = null;
      activateAppView('home');
      render();
      return;
    }
 
    try {
      await DB.ensureUserProfile(user);
    } catch (error) {
      console.error(error);
      toast('No se pudo preparar tu perfil en Firestore. Revisa reglas y conexion.', 'error');
      render();
      return;
    }
 
    unsubProfile = DB.subscribeUserProfile(user.uid, (profile) => {
      state.profile = profile;
      if (!profile) {
        render();
        return;
      }
      void (async () => {
        try {
          await auth.currentUser?.getIdToken(true);
          if (isAdmin(profile)) {
            await DB.bootstrapDefaults(user.uid);
          }
        } catch (error) {
          console.error(error);
        }
        startDataSync();
        render();
      })();
    });
  });
 
  document.getElementById('btn-open-auth')?.addEventListener('click', () => {
    if (state.authUser) {
      activateAppView('profile');
      render();
      return;
    }
    openModal('modal-auth');
  });
 
  document.getElementById('btn-google-signin')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    if (button && 'disabled' in button) button.disabled = true;
    toast('Abriendo Google…', 'info', 1200);
    try {
      await signInWithGoogle();
      // ensureUserProfile lo ejecuta observeSession; duplicarlo aqui provocaba
      // dos setDoc seguidos (el 2º como update) y permission-denied en reglas.
      closeAllModals();
      toast('Sesion iniciada con Google.', 'success');
    } catch (error) {
      console.error(error);
      const code = error?.code ?? '';
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
        toast('Inicio con Google cancelado.', 'info');
        return;
      }
      if (code === 'auth/popup-blocked') {
        toast('El navegador bloqueo la ventana emergente. Permite popups para este sitio.', 'error');
        return;
      }
      if (code === 'auth/unauthorized-domain') {
        toast('Dominio no autorizado en Firebase Auth. Agrega este dominio en Authorized domains.', 'error');
        return;
      }
      if (code === 'auth/account-exists-with-different-credential') {
        toast('Ese correo ya tiene cuenta con otro metodo. Usa correo y contrasena.', 'error');
        return;
      }
      toast(
        'No se pudo usar Google. En Firebase Console → Authentication → Sign-in method, activa Google.',
        'error'
      );
    } finally {
      if (button && 'disabled' in button) button.disabled = false;
    }
  });

  document.getElementById('btn-login')?.addEventListener('click', async () => {
    const email = document.getElementById('auth-email')?.value.trim();
    const password = document.getElementById('auth-password')?.value;
 
    if (!email || !password) {
      toast('Debes ingresar correo y contrasena.', 'error');
      return;
    }
 
    try {
      await signIn(email, password);
      closeAllModals();
      toast('Sesion iniciada.', 'success');
    } catch (error) {
      console.error(error);
      const code = error?.code ?? '';
      if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found') {
        toast(
          'Correo o contrasena incorrectos, o la cuenta no existe. Crea el usuario en Firebase Console → Authentication → Users, o revisa el metodo de acceso (correo/contrasena activado).',
          'error'
        );
        return;
      }
      if (code === 'auth/invalid-email') {
        toast('El formato del correo no es valido.', 'error');
        return;
      }
      if (code === 'auth/user-disabled') {
        toast('Esta cuenta esta deshabilitada.', 'error');
        return;
      }
      if (code === 'auth/too-many-requests') {
        toast('Demasiados intentos. Espera unos minutos o restablece la contrasena.', 'error');
        return;
      }
      toast('No se pudo iniciar sesion. Verifica correo, contrasena y Firebase Auth.', 'error');
    }
  });
 
  document.getElementById('btn-logout')?.addEventListener('click', async () => {
    if (!state.authUser) return;
    await logout();
    toast('Sesion cerrada.', 'success');
  });

  document.getElementById('btn-profile-logout')?.addEventListener('click', async () => {
    if (!state.authUser) return;
    await logout();
    toast('Sesion cerrada.', 'success');
  });
}

/**
 * Si Firestore devuelve permission-denied, las suscripciones vacían listas (users, turnos)
 * y la UI parece “sin pendientes”. Avisar una vez por pestaña: reglas desplegadas + bloqueadores.
 */
function onFirestorePermissionDeniedHint(error) {
  if ((error?.code ?? '') !== 'permission-denied') return;
  try {
    if (sessionStorage.getItem('predicapp_fs_perm_hint')) return;
    sessionStorage.setItem('predicapp_fs_perm_hint', '1');
  } catch (_) {
    return;
  }
  toast(
    'Firestore denegó permisos: las listas pueden verse vacías aunque sí haya solicitudes. '
      + 'Despliega las reglas del proyecto (`firebase deploy --only firestore:rules`) y comprueba en '
      + 'Firebase Console → Firestore → Reglas. En Brave u otros navegadores, desactiva escudos o '
      + 'extensiones que bloqueen googleapis (ERR_BLOCKED_BY_CLIENT).',
    'error',
    16000
  );
}
 
function startDataSync() {
  unsubUsers?.();
  unsubUsers = null;

  if (isAdmin(state.profile)) {
    unsubUsers = DB.subscribeUsers((users) => {
      state.users = users;
      render();
    }, onFirestorePermissionDeniedHint);
  } else {
    state.users = [];
  }

  unsubPendingUsers?.();
  unsubPendingUsers = null;
  if (isSubadmin(state.profile) && canUseAppDataProfile()) {
    const ids = Array.isArray(state.profile?.assignedPointIds)
      ? state.profile.assignedPointIds.map((x) => String(x ?? '').trim()).filter(Boolean)
      : [];
    if (ids.length) {
      unsubPendingUsers = DB.subscribePendingUsersByPoints(
        ids,
        (rows) => {
          state.pendingUsersCaptain = rows;
          render();
        },
        onFirestorePermissionDeniedHint
      );
    } else {
      state.pendingUsersCaptain = [];
    }
  } else {
    state.pendingUsersCaptain = [];
  }

  unsubPoints?.();
  unsubPoints = DB.subscribePoints(({ points }) => {
    state.points = points;
    state.visiblePoints = canUseAppDataProfile()
      ? getVisiblePoints(state.profile, points)
      : [];

    if (canUseAppDataProfile()) {
      subscribeVisibleParticipantsDirectory();

      const fallbackPointId = getDefaultPointId(state.profile, state.visiblePoints);
      const nextPointId = state.visiblePoints.some((point) => point.id === state.selectedPointId)
        ? state.selectedPointId
        : fallbackPointId;

      if (nextPointId !== state.selectedPointId) {
        switchPoint(nextPointId);
        return;
      }
    } else {
      unsubParticipantsDirectory?.();
      unsubParticipantsDirectory = null;
      unsubPointData?.();
      unsubPointData = null;
      state.participantsDirectory = [];
      state.participants = [];
      state.slots = {};
      state.reports = [];
      state.selectedPointId = '';
    }

    populatePointSelects();
    render();
  });
}
 
function switchPoint(pointId, opts = {}) {
  if (!opts.keepPendingHomeDestination) {
    pendingHomeDestination = '';
  }
  state.selectedPointId = pointId ?? '';
  DB.setSelectedPoint(state.selectedPointId);
 
  unsubPointData?.();
  unsubPointData = DB.subscribePointData(
    state.selectedPointId,
    ({ participants, slots, reports }) => {
      state.participants = participants;
      state.slots = slots;
      state.reports = reports;

      maybeEnsureDefaultSlotsForSelectedPoint();

      const dest = pendingHomeDestination;
      if (dest) {
        pendingHomeDestination = '';
        const tabSel = {
          reserve: '.nav-tab[data-view="reserve"]',
          people: '.nav-tab[data-view="people"]',
          board: '.nav-tab[data-view="board"]'
        }[dest];
        if (tabSel) {
          queueMicrotask(() => {
            document.querySelector(tabSel)?.click();
          });
        }
      }

      hydrateDaySelectForPoint();
      populateParticipantSelects();
      populatePointSelects();
      render();
    },
    (err) => onFirestorePermissionDeniedHint(err)
  );
}
 
function subscribeVisibleParticipantsDirectory() {
  unsubParticipantsDirectory?.();
  const pointIds = state.visiblePoints.map((point) => point.id);
  unsubParticipantsDirectory = DB.subscribeParticipantsDirectory(pointIds, (rows) => {
    state.participantsDirectory = rows;
    if (!rows.some((participant) => participant.id === state.selectedDirectoryParticipantId)) {
      state.selectedDirectoryParticipantId = rows[0]?.id ?? '';
    }
    renderHomeDirectory();
  });
}
 
function setupConnectionBadge() {
  const badge = document.getElementById('offline-badge');
  onConnectionChange((online) => {
    if (badge) badge.style.display = online ? 'none' : 'inline-flex';
    if (online) {
      refreshEnrollPointOptions({ silentToast: true }).catch(() => {});
    }
  });
}

function profileNeedsAssignedPoint(profile) {
  if (!profile) return false;
  const id = String(profile.assignedPointId ?? '').trim();
  if (id) return false;
  const ids = profile.assignedPointIds;
  if (Array.isArray(ids) && ids.some((x) => String(x ?? '').trim() !== '')) return false;
  return true;
}

async function refreshEnrollPointOptions(opts = {}) {
  const silentToast = Boolean(opts.silentToast);
  const enrollSel = document.getElementById('enroll-point');
  const completeSel = document.getElementById('complete-point-select');
  if (!enrollSel && !completeSel) return;
  try {
    const points = await DB.listPointDocumentsPublic();
    state.enrollPoints = points;
    const baseOpts = points.length
      ? [
        { value: '', label: 'Selecciona un punto…' },
        ...points.map((p) => ({ value: p.id, label: p.name || p.id }))
      ]
      : [{ value: '', label: 'No hay puntos disponibles' }];

    if (enrollSel) {
      renderSelectOptions(enrollSel, baseOpts);
      enrollSel.value = '';
    }

    if (completeSel) {
      renderSelectOptions(completeSel, baseOpts);
    }
  } catch (error) {
    console.error(error);
    state.enrollPoints = [];
    const errOpt = [{ value: '', label: 'No se pudieron cargar los puntos (revisa reglas de Firestore).' }];
    if (enrollSel) renderSelectOptions(enrollSel, errOpt);
    if (completeSel) renderSelectOptions(completeSel, errOpt);
    if (!silentToast) {
      toast('No se pudieron cargar los puntos. Comprueba conexion y reglas de Firestore.', 'error');
    }
  }
}

function syncHomePendingPanels() {
  const wait = document.getElementById('home-pending-wait');
  const main = document.getElementById('home-main-content');
  const guest = document.getElementById('guest-enroll-panel');
  if (!wait || !main) return;

  const usuarioPendiente = Boolean(
    state.authUser && state.profile && isPendingUserApproval(state.profile)
  );

  if (guest) {
    guest.style.display = state.authUser ? 'none' : '';
  }

  const needsPoint = Boolean(state.profile && profileNeedsAssignedPoint(state.profile));
  const canShowMainWhilePending = Boolean(usuarioPendiente && needsPoint);

  if (usuarioPendiente) {
    wait.style.display = '';
    main.style.display = canShowMainWhilePending ? '' : 'none';
    const sub = document.getElementById('logged-pick-point-subtitle');
    if (sub) {
      sub.textContent = needsPoint
        ? 'Selecciona el punto donde participas para que el capitán pueda aprobarte.'
        : 'Tu cuenta esta en espera de aprobacion del capitán.';
    }
  } else {
    wait.style.display = 'none';
    main.style.display = '';
  }
}

function getPendingApprovalRows() {
  if (!state.profile) return [];
  if (isAdmin(state.profile)) {
    return state.users.filter(
      (u) => u.role === ROLES.USER && u.status === USER_STATUS.PENDIENTE
    );
  }
  if (isSubadmin(state.profile)) {
    return state.pendingUsersCaptain;
  }
  return [];
}

function renderPendingApprovalList() {
  const section = document.getElementById('captain-pending-approval');
  const list = document.getElementById('captain-pending-users-list');
  if (!section || !list) return;

  const show = Boolean(
    state.authUser
    && canUseAppDataProfile()
    && (isAdmin(state.profile) || isSubadmin(state.profile))
  );
  section.style.display = show ? '' : 'none';
  if (!show) return;

  const rows = getPendingApprovalRows();
  list.innerHTML = '';
  if (!rows.length) {
    const empty = document.createElement('li');
    empty.className = 'list-empty';
    empty.textContent = 'No hay cuentas pendientes.';
    list.appendChild(empty);
    return;
  }

  rows.forEach((u) => {
    const item = document.createElement('li');
    item.className = 'admin-list-item';

    const main = document.createElement('div');
    main.className = 'admin-list-item__main';
    const label = document.createElement('span');
    const email = u.email || u.id;
    const name = String(u.displayName ?? '').trim() || '—';
    label.textContent = `${name} · ${email}`;
    main.appendChild(label);
    const meta = document.createElement('span');
    meta.className = 'view-muted';
    meta.style.fontSize = '.8rem';
    const pids = Array.isArray(u.assignedPointIds) ? u.assignedPointIds.filter(Boolean).join(', ') : '';
    meta.textContent = pids ? `Puntos: ${pids}` : 'Sin punto asignado';
    main.appendChild(meta);
    item.appendChild(main);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-secondary';
    btn.textContent = 'Aprobar';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await DB.aprobarUsuario(u.id);
        toast('Usuario aprobado.', 'success');
      } catch (error) {
        console.error(error);
        toast(error?.message || 'No se pudo aprobar.', 'error');
      } finally {
        btn.disabled = false;
      }
    });
    item.appendChild(btn);
    list.appendChild(item);
  });
}

function updateLoggedPickPointPanel() {
  const el = document.getElementById('logged-pick-point-panel');
  const completeSel = document.getElementById('complete-point-select');
  if (!el) return;

  const needsPoint = Boolean(
    state.authUser && state.profile && profileNeedsAssignedPoint(state.profile)
  );

  const showPick = Boolean(
    needsPoint && (canUseAppDataProfile() || isPendingUserApproval(state.profile))
  );

  el.style.display = showPick ? '' : 'none';
  if (!showPick || !completeSel) return;

  if (!state.enrollPoints.length) {
    refreshEnrollPointOptions({ silentToast: true }).catch(() => {});
    return;
  }

  const completeOpts = [
    { value: '', label: 'Selecciona un punto…' },
    ...state.enrollPoints.map((p) => ({ value: p.id, label: p.name || p.id }))
  ];
  renderSelectOptions(completeSel, completeOpts);
}

function setupCompleteFirstPoint() {
  document.getElementById('btn-complete-first-point')?.addEventListener('click', async () => {
    if (!state.authUser?.uid || !state.profile) {
      toast('Debes tener sesion iniciada.', 'error');
      return;
    }
    if (!profileNeedsAssignedPoint(state.profile)) {
      toast('Ya tienes un punto asignado.', 'info');
      return;
    }
    const pointId = document.getElementById('complete-point-select')?.value ?? '';
    if (!pointId) {
      toast('Selecciona un punto.', 'error');
      return;
    }
    const point = state.enrollPoints.find((p) => p.id === pointId);
    if (!point) {
      toast('Punto invalido. Recarga la pagina.', 'error');
      return;
    }
    const btn = document.getElementById('btn-complete-first-point');
    if (btn) btn.disabled = true;
    try {
      await DB.saveUserProfile(state.authUser.uid, {
        assignedPointId: point.id,
        assignedPointName: String(point.name ?? '').trim() || point.id,
        assignedSubadminId: String(point.subadminId ?? '').trim(),
        assignedSubadminName: String(point.subadminName ?? '').trim()
      });
      toast('Punto guardado correctamente.', 'success');
    } catch (error) {
      console.error(error);
      toast('No se pudo guardar el punto. Revisa las reglas de Firestore.', 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  });
}

function setupEnrollForm() {
  const btn = document.getElementById('btn-enroll-submit');
  btn?.addEventListener('click', async () => {
    const name = document.getElementById('enroll-display-name')?.value.trim() ?? '';
    const phone = document.getElementById('enroll-phone')?.value.trim() ?? '';
    const pointId = document.getElementById('enroll-point')?.value ?? '';
    const preferredDay = document.getElementById('enroll-day')?.value ?? '';
    const preferredTime = document.getElementById('enroll-time')?.value ?? '';

    if (!pointId) {
      toast('Selecciona un punto de predicacion.', 'error');
      return;
    }
    if (!name) {
      toast('El nombre es obligatorio.', 'error');
      return;
    }
    if (!preferredDay) {
      toast('Selecciona un dia preferido.', 'error');
      return;
    }
    if (!preferredTime) {
      toast('Selecciona una hora preferida.', 'error');
      return;
    }

    const point = state.enrollPoints.find((p) => p.id === pointId);
    if (!point) {
      toast('Punto invalido. Recarga la pagina e intenta de nuevo.', 'error');
      return;
    }

    btn.disabled = true;
    try {
      const result = await DB.enrollParticipantPublic({
        pointId: point.id,
        name,
        phone,
        preferredDay,
        preferredTime
      });

      if (result?.alreadyExists) {
        toast('Ese participante ya esta inscrito en el punto seleccionado.', 'info');
      } else {
        toast('Inscripcion registrada correctamente.', 'success');
      }

      setValue('enroll-display-name', '');
      setValue('enroll-phone', '');
      setValue('enroll-point', '');
      setValue('enroll-day', '');
      setValue('enroll-time', '');
    } catch (error) {
      console.error(error);
      toast(error?.message || 'No se pudo completar la inscripcion.', 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

function hydrateEnrollTimeSelect() {
  const enrollDay = document.getElementById('enroll-day');
  const enrollTime = document.getElementById('enroll-time');
  if (enrollDay) {
    renderSelectOptions(enrollDay, [
      { value: '', label: 'Selecciona un dia…' },
      ...DAYS.map((day) => ({ value: day, label: day }))
    ]);
  }
  if (!enrollTime) return;
  renderSelectOptions(enrollTime, [
    { value: '', label: 'Selecciona una hora…' },
    ...TIMES.map((time) => ({ value: time, label: time }))
  ]);
}

function setupProfileGuestNav() {
  document.getElementById('btn-profile-go-enroll')?.addEventListener('click', () => {
    activateAppView('home');
    render();
    requestAnimationFrame(() => {
      document.getElementById('guest-enroll-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
  document.getElementById('btn-profile-go-login')?.addEventListener('click', () => {
    openModal('modal-auth');
  });
}
 
function setupNav() {
  document.querySelectorAll('.nav-tab[data-view]').forEach((tab) => {
    tab.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        tab.click();
      }
    });

    tab.addEventListener('click', () => {
      if (tab.hasAttribute('data-auth-required') && !state.authUser) {
        toast('Inicia sesion para acceder a esta seccion.', 'info');
        openModal('modal-auth');
        return;
      }
      if (tab.hasAttribute('data-requires-access') && state.authUser && !canUseAppDataProfile()) {
        toast('Tu acceso a turnos y tablero aun no esta activo (espera activacion del super o del capitán según corresponda).', 'info');
        return;
      }
      activateAppView(tab.dataset.view);
      render();
    });
  });
}
 
function setupModals() {
  document.querySelectorAll('.close-btn, .close-modal').forEach((button) => {
    button.addEventListener('click', closeAllModals);
  });
 
  document.querySelectorAll('.modal').forEach((modal) => {
    modal.addEventListener('click', (event) => {
      if (event.target === modal) closeAllModals();
    });
  });
}
 
function openTab(viewName) {
  const tab = document.querySelector(`.nav-tab[data-view="${viewName}"]`);
  if (tab) {
    tab.click();
    return;
  }
  activateAppView(viewName);
  render();
}
 
function openModal(id) {
  document.getElementById(id)?.classList.add('active');
}

function closeModal(id) {
  document.getElementById(id)?.classList.remove('active');
}

function closeAllModals() {
  document.querySelectorAll('.modal').forEach((modal) => modal.classList.remove('active'));
}

function setupReassignModal() {
  const modal = document.getElementById('modal-reassign-point');
  if (!modal) return;

  document.getElementById('btn-reassign-keep-point')?.addEventListener('click', () => {
    closeReassignModal(false);
  });

  document.getElementById('btn-reassign-confirm')?.addEventListener('click', () => {
    closeReassignModal(true);
  });

  modal.addEventListener('click', (event) => {
    if (event.target === modal) {
      closeReassignModal(false);
    }
  });
}

function closeReassignModal(confirmed) {
  closeModal('modal-reassign-point');
  const resolver = reassignModalResolver;
  reassignModalResolver = null;
  resolver?.(confirmed);
}

function showReassignModal(payload) {
  populateReassignModal(payload);
  openModal('modal-reassign-point');
  return new Promise((resolve) => {
    reassignModalResolver = resolve;
  });
}
 
function setupPointFilter() {
  document.getElementById('filter-point')?.addEventListener('change', (event) => {
    switchPoint(event.target.value);
  });
 
  document.getElementById('sel-reserve-point')?.addEventListener('change', (event) => {
    if (event.target.value !== state.selectedPointId) {
      switchPoint(event.target.value);
    }
  });
}
 
function setupHome() {
  const searchInput = document.getElementById('home-participant-search');
  const list = document.getElementById('home-participant-list');
  const goReserve = document.getElementById('btn-home-go-reserve');
  const goPeople = document.getElementById('btn-home-go-people');
  const goBoard = document.getElementById('btn-home-go-board');
 
  searchInput?.addEventListener('input', () => {
    state.participantQuery = searchInput.value.trim();
    const filtered = getFilteredParticipantsDirectory();
    if (!filtered.some((participant) => participant.id === state.selectedDirectoryParticipantId)) {
      state.selectedDirectoryParticipantId = filtered[0]?.id ?? '';
    }
    renderHomeDirectory();
  });
 
  list?.addEventListener('change', () => {
    state.selectedDirectoryParticipantId = list.value || '';
    renderHomeSelectionCard();
  });
 
  list?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      goToHomeDestination('reserve');
    }
  });
 
  goReserve?.addEventListener('click', () => goToHomeDestination('reserve'));
  goPeople?.addEventListener('click', () => goToHomeDestination('people'));
  goBoard?.addEventListener('click', () => goToHomeDestination('board'));
}
 
function hydrateDayTimeSelects() {
  renderSelectOptions(
    document.getElementById('select-day'),
    DAYS.map((day) => ({ value: day, label: day }))
  );
 
  renderSelectOptions(
    document.getElementById('select-time'),
    TIMES.map((time) => ({ value: time, label: time }))
  );
 
  document.getElementById('select-day')?.addEventListener('change', syncSelectedSlotSummary);
  document.getElementById('select-time')?.addEventListener('change', syncSelectedSlotSummary);
}
 
function hydrateDaySelectForPoint() {
  const daySelect = document.getElementById('select-day');
  if (!daySelect) return;
 
  const daysWithSlots = DAYS.filter((day) => Array.isArray(state.slots[day]) && state.slots[day].length);
  const currentValue = daySelect.value;
  const options = (daysWithSlots.length ? daysWithSlots : DAYS).map((day) => ({ value: day, label: day }));
 
  renderSelectOptions(daySelect, options);
 
  daySelect.value = daysWithSlots.includes(currentValue)
    ? currentValue
    : (daysWithSlots[0] ?? DAYS[0]);
}
 
function populatePointSelects() {
  const pointOptions = state.visiblePoints.length
    ? state.visiblePoints.map((point) => ({ value: point.id, label: point.name }))
    : [{ value: '', label: 'Sin puntos' }];
 
  const filterPoint = document.getElementById('filter-point');
  const reservePoint = document.getElementById('sel-reserve-point');
  const subadminPoint = document.getElementById('subadmin-point');
 
  if (filterPoint) {
    renderSelectOptions(filterPoint, pointOptions);
    filterPoint.value = state.selectedPointId || '';
    filterPoint.disabled = state.visiblePoints.length <= 1;
  }
 
  if (reservePoint) {
    renderSelectOptions(reservePoint, pointOptions);
    reservePoint.value = state.selectedPointId || '';
    reservePoint.disabled = !state.visiblePoints.length;
  }
 
  if (subadminPoint) {
    const allPointOptions = state.points.length
      ? state.points.map((point) => ({ value: point.id, label: point.name }))
      : [{ value: '', label: 'Sin puntos' }];
    renderSelectOptions(subadminPoint, allPointOptions);
  }

  const subadminUidDatalist = document.getElementById('subadmin-uid-datalist');
  if (subadminUidDatalist) {
    subadminUidDatalist.innerHTML = '';
    state.users.forEach((u) => {
      const opt = document.createElement('option');
      opt.value = u.id;
      const mail = String(u.email ?? '').trim();
      const name = String(u.displayName ?? '').trim();
      opt.label = [mail, name].filter(Boolean).join(' · ') || u.id;
      subadminUidDatalist.appendChild(opt);
    });
  }

  syncSelectedSlotSummary();
  renderAdminLists();
}
 
function populateParticipantSelects() {
  const participantOptions = state.participants.length
    ? state.participants.map((participant) => ({ value: participant.name, label: participant.name }))
    : [{ value: '', label: 'Sin participantes' }];
 
  renderSelectOptions(document.getElementById('sel-participant'), participantOptions);
 
  const companionOptions = [{ value: '', label: 'Ninguno' }, ...participantOptions];
  renderSelectOptions(document.getElementById('sel-companion1'), companionOptions);
  renderSelectOptions(document.getElementById('sel-companion2'), companionOptions);
 
  if (state.pendingReserveParticipantName) {
    setValue('sel-participant', state.pendingReserveParticipantName);
    state.pendingReserveParticipantName = '';
  }
}
 
function syncAccessBadges() {
  const roleBadge = document.getElementById('role-badge');
  const emailBadge = document.getElementById('session-email');
  const logoutButton = document.getElementById('btn-logout');
  const authButton = document.getElementById('btn-open-auth');

  if (roleBadge) {
    if (!state.authUser) {
      roleBadge.textContent = 'Participante';
    } else if (isAdmin(state.profile)) {
      roleBadge.textContent = getRoleLabel(ROLES.ADMIN);
    } else if (isSubadmin(state.profile)) {
      roleBadge.textContent = getRoleLabel(ROLES.SUBADMIN);
    } else {
      roleBadge.textContent = getRoleLabel(ROLES.USER);
    }
  }

  if (emailBadge) {
    emailBadge.textContent = state.authUser?.email ?? 'Sin sesion';
  }

  if (logoutButton) {
    logoutButton.style.display = state.authUser ? '' : 'none';
  }

  if (authButton) {
    authButton.textContent = state.authUser ? 'Cuenta' : 'Entrar';
  }
}
 
function setupReserveForm() {
  const saveButton = document.getElementById('btn-save-reserve-form');
  const cancelButton = document.getElementById('btn-cancel-my-reservation');
 
  const setLoading = (loading) => {
    if (saveButton) saveButton.disabled = loading;
    if (cancelButton) cancelButton.disabled = loading || !state.canCancelOwnReservation;
  };

  saveButton?.addEventListener('click', async () => {
    await handleReservar(setLoading);
  });
 
  cancelButton?.addEventListener('click', async () => {
    if (!state.authUser || !state.profile) {
      toast('Debes iniciar sesion para cancelar tu turno.', 'error');
      return;
    }
 
    const day = document.getElementById('select-day')?.value;
    const time = document.getElementById('select-time')?.value;
    if (!day || !time) {
      toast('Selecciona dia y horario.', 'error');
      return;
    }
 
    const ok = await confirm('Deseas cancelar tu reserva en este turno?');
    if (!ok) return;
 
    setLoading(true);
    let result;
    try {
      result = await DB.cancelOwnReservation({
        pointId: state.selectedPointId,
        day,
        time,
        actor: { uid: state.authUser.uid }
      });
    } catch (error) {
      console.error(error);
      result = { ok: false, error: 'Error inesperado al cancelar la reserva.' };
    } finally {
      setLoading(false);
    }
 
    if (!result.ok) {
      toast(result.error ?? 'No se pudo cancelar tu reserva.', 'error');
      return;
    }
 
    syncSelectedSlotSummary();
    render();
    toast('Tu reserva fue cancelada.', result.offline ? 'warning' : 'success');
    if (state.currentView === 'my-reservations') {
      loadMyReservationsList();
    }
  });
}

/**
 * Aplica el resultado de una operación de reserva exitosa:
 * actualiza UI, muestra toast y recarga lista si corresponde.
 */
function applyReservationResult(saveResult) {
  syncSelectedSlotSummary();
  render();

  const managerSaved = canManageSlots(state.profile, state.selectedPointId);
  const successMessage = saveResult.removedReservations
    ? 'Reserva guardada y punto reasignado.'
    : managerSaved
      ? (saveResult.mode === 'updated' ? 'Reserva actualizada.' : 'Reserva guardada.')
      : (saveResult.mode === 'updated' ? 'Solicitud actualizada.' : 'Solicitud enviada; el capitán la revisará.');

  toast(successMessage, saveResult.offline ? 'warning' : 'success');

  if (state.currentView === 'my-reservations') {
    loadMyReservationsList();
  }
}

async function handleReservar(setLoading) {
  if (!state.authUser || !state.profile) {
    toast('Debes iniciar sesion para gestionar tu turno.', 'error');
    return;
  }

  if (!canUseAppDataProfile()) {
    toast('Tu cuenta aun no tiene permiso para reservar.', 'error');
    return;
  }

  if (!state.selectedPointId) {
    toast('Selecciona un punto.', 'error');
    return;
  }

  const day = document.getElementById('select-day')?.value;
  const time = document.getElementById('select-time')?.value;
  const participant = document.getElementById('sel-participant')?.value;
  const companion1 = document.getElementById('sel-companion1')?.value || '';
  const companion2 = document.getElementById('sel-companion2')?.value || '';
  const pointName = getSelectedPoint()?.name ?? '';

  if (!day || !time || !participant) {
    toast('Selecciona dia, horario y participante.', 'error');
    return;
  }

  const slot = state.slots[day]?.find((item) => item.time === time);
  if (!slot) {
    toast('No se encontro el turno seleccionado.', 'error');
    return;
  }

  const reservationPayload = {
    userId: state.authUser.uid,
    name: participant,
    point: pointName,
    companions: [companion1, companion2]
  };

  setLoading(true);

  // ── Fase 1: detectar conflictos (lectura; fuera de la transacción de escritura) ──
  let existingReservations;
  let conflict;
  try {
    existingReservations = await DB.getUserReservationsAcrossPoints(state.authUser.uid);
    const selectedPoint = getSelectedPoint();
    conflict = detectConflict(
      existingReservations,
      day,
      time,
      state.selectedPointId,
      {
        pointName: selectedPoint?.name ?? pointName,
        subadminName: selectedPoint?.subadminName ?? ''
      }
    );
  } catch (error) {
    console.error(error);
    setLoading(false);
    toast('No se pudo verificar reservas existentes.', 'error');
    return;
  }

  // ── Fase 2: actuar según resultado del conflicto ──
  if (conflict.status === 'blocked') {
    setLoading(false);
    const cs = conflict.conflictingSlot;
    const label = existingReservations.find((r) => r.pointId === cs.pointId)?.pointName || cs.pointId;
    toast(
      cs?.day && cs?.time
        ? `Ya tienes una reserva activa en ${label} para ${cs.day} ${cs.time}.`
        : 'Ya tienes una reserva activa en otro punto para ese mismo horario.',
      'error'
    );
    return;
  }

  if (conflict.status === 'warn') {
    // Mostrar modal de confirmación con el botón ya deshabilitado.
    setLoading(false);
    const selectedPoint = getSelectedPoint();
    const reassignPayload = {
      from: {
        pointId: conflict.from.pointId || state.profile?.assignedPointId || '',
        pointName: conflict.from.pointName || state.profile?.assignedPointName || 'Punto actual',
        subadminName: conflict.from.subadminName || state.profile?.assignedSubadminName || 'Sin capitán asignado'
      },
      to: {
        pointId: conflict.to.pointId,
        pointName: conflict.to.pointName || selectedPoint?.name || pointName,
        subadminName: conflict.to.subadminName || selectedPoint?.subadminName || 'Sin capitán asignado'
      },
      affectedReservations: conflict.affectedReservations
    };

    const confirmed = await showReassignModal(reassignPayload);
    // El usuario canceló: salida limpia, sin toast de error.
    if (!confirmed) return;

    // Reasignar: flujo independiente con su propio try/catch.
    setLoading(true);
    let saveResult;
    try {
      saveResult = await DB.reassignUserToPoint(state.authUser.uid, state.selectedPointId, {
        ...reservationPayload,
        day,
        time
      });
    } catch (error) {
      console.error(error);
      setLoading(false);
      toast('Error inesperado al reasignar el punto.', 'error');
      return;
    }
    setLoading(false);
    if (!saveResult.ok) {
      toast(saveResult.error ?? 'No se pudo reasignar el punto.', 'error');
      return;
    }
    applyReservationResult(saveResult);
    return;
  }

  // ── Fase 3: reserva normal (sin conflicto) ──
  let saveResult;
  try {
    saveResult = await DB.upsertReservation({
      pointId: state.selectedPointId,
      day,
      time,
      reservation: reservationPayload,
      actor: {
        uid: state.authUser.uid,
        role: state.profile.role,
        assignedPointIds: state.profile.assignedPointIds ?? []
      }
    });
  } catch (error) {
    console.error(error);
    setLoading(false);
    toast('Error inesperado al guardar la reserva.', 'error');
    return;
  }
  setLoading(false);
  if (!saveResult.ok) {
    toast(saveResult.error ?? 'No se pudo guardar la reserva.', 'error');
    return;
  }
  applyReservationResult(saveResult);
}
 
function syncSelectedSlotSummary() {
  const summary = document.getElementById('selected-slot-summary');
  const day = document.getElementById('select-day')?.value;
  const time = document.getElementById('select-time')?.value;
  const cancelBtn = document.getElementById('btn-cancel-my-reservation');
 
  if (!summary) return;
 
  if (!day || !time) {
    summary.textContent = 'Selecciona un dia y un horario.';
    state.canCancelOwnReservation = false;
    if (cancelBtn) cancelBtn.disabled = true;
    return;
  }
 
  const slot = state.slots[day]?.find((item) => item.time === time);
  if (!slot) {
    summary.textContent = 'El turno seleccionado aun no existe en este punto.';
    state.canCancelOwnReservation = false;
    if (cancelBtn) cancelBtn.disabled = true;
    return;
  }
 
  const people = countPeople(slot);
  const names = getPeopleNames(slot, true);
  let suffix = names.length ? ` Confirmados: ${names.join(', ')}` : '';
  const pendingMine = slot.reservations?.find(
    (r) =>
      r.userId === state.authUser?.uid && r.approvalStatus === RESERVATION_APPROVAL.PENDING
  );
  if (pendingMine) {
    suffix += ' · Tu solicitud esta pendiente del capitán.';
  }
  summary.textContent = `${day} ${time} - ${people}/${MAX_RESERVATIONS_PER_SLOT}.${suffix}`;

  const mine = Boolean(state.authUser?.uid) && (slot.reservations ?? []).some(
    (reservation) =>
      reservation.userId === state.authUser.uid && reservation.approvalStatus !== 'rejected'
  );
  state.canCancelOwnReservation = mine;
 
  if (cancelBtn) {
    cancelBtn.disabled = !mine;
    cancelBtn.title = mine ? '' : 'No tienes reserva en este turno.';
  }
}
 
function setupParticipants() {
  document.getElementById('btn-open-add-part')?.addEventListener('click', () => {
    if (!canEditParticipants(state.profile, state.selectedPointId)) {
      toast('Solo el super de servicio o el capitán del punto puede agregar participantes.', 'error');
      return;
    }
 
    setValue('inp-part-name', '');
    setValue('inp-part-phone', '');
    openModal('modal-participant');
  });
 
  document.getElementById('btn-save-part')?.addEventListener('click', async () => {
    if (!canEditParticipants(state.profile, state.selectedPointId)) {
      toast('No tienes permisos para esta accion.', 'error');
      return;
    }
 
    if (!state.selectedPointId) {
      toast('Selecciona un punto valido.', 'error');
      return;
    }
 
    const rawName = document.getElementById('inp-part-name')?.value.trim() ?? '';
    const name = rawName.slice(0, 80);
    const phone = (document.getElementById('inp-part-phone')?.value.trim() ?? '').slice(0, 30);
 
    if (!name) {
      toast('El nombre es obligatorio.', 'error');
      return;
    }
 
    try {
      const result = await DB.addParticipant(state.selectedPointId, {
        name,
        phone
      });
      if (!result.ok) {
        toast(result.error ?? 'No se pudo agregar el participante.', 'error');
        return;
      }
      closeAllModals();
      toast('Participante agregado.', result.offline ? 'warning' : 'success');
    } catch (error) {
      console.error(error);
      if (error?.code === 'permission-denied') {
        toast(
          'Sin permiso en Firestore: tu cuenta debe estar aprobada, con acceso a este punto y rol adecuado (super, capitán o publicador del punto). Revisa reglas y documento users/{tuUid}.',
          'error',
          12000
        );
      } else {
        toast('No se pudo agregar el participante.', 'error');
      }
    }
  });
}
 
function setupAdmin() {
  document.getElementById('btn-add-point')?.addEventListener('click', async () => {
    if (!canManagePoints(state.profile)) {
      toast('Solo el super de servicio puede crear puntos.', 'error');
      return;
    }
 
    const pointNameInput = await promptInput('Nombre del nuevo punto:');
    const pointName = pointNameInput?.trim() ?? '';
    if (!pointName) return;
 
    const pointId = normalizePointId(pointName);
    if (state.points.some((point) => point.id === pointId)) {
      toast('Ese punto ya existe.', 'error');
      return;
    }
 
    try {
      await DB.createPoint({
        pointId,
        name: pointName.slice(0, 80),
        createdBy: state.authUser?.uid ?? ''
      });
      toast('Punto creado.', 'success');
    } catch (error) {
      console.error(error);
      if (error?.code === 'permission-denied') {
        toast(
          'Firestore denegó crear el punto: despliega las reglas (firebase deploy --only firestore:rules), '
            + 'confirma en users/{tuUid} el campo role exactamente admin, y recarga sin caché (Ctrl+Shift+R).',
          'error',
          14000
        );
      } else {
        const msg = String(error?.message ?? '').trim();
        toast(msg || 'No se pudo crear el punto.', 'error');
      }
    }
  });
 
  document.getElementById('btn-create-subadmin')?.addEventListener('click', async () => {
    if (!canCreateSubadmin(state.profile)) {
      toast('Solo el super de servicio puede asignar capitanes.', 'error');
      return;
    }
 
    const uidRaw = document.getElementById('subadmin-uid')?.value.trim() ?? '';
    const emailRaw = document.getElementById('subadmin-email')?.value.trim() ?? '';
    const displayNameRaw = document.getElementById('subadmin-name')?.value.trim() ?? '';
    const pointId = document.getElementById('subadmin-point')?.value;

    if (!pointId) {
      toast('Elige el punto asignado al capitán.', 'error');
      return;
    }

    const resolved = resolveCaptainAssignTarget(uidRaw, emailRaw, displayNameRaw);
    if ('error' in resolved) {
      toast(resolved.error, 'error');
      return;
    }

    const { uid, email, displayName } = resolved;

    if (email && !isValidEmail(email)) {
      toast('Ingresa un correo valido para el capitán.', 'error');
      return;
    }

    try {
      await DB.saveUserProfile(uid, {
        email,
        displayName,
        role: ROLES.SUBADMIN,
        assignedPointIds: [pointId],
        adminApproved: true
      });
      await DB.assignSubadminToPoint(pointId, { id: uid, displayName, email });
 
      setValue('subadmin-uid', '');
      setValue('subadmin-email', '');
      setValue('subadmin-name', '');
      toast('Capitán asignado al punto.', 'success');
    } catch (error) {
      console.error(error);
      toast('No se pudo asignar el capitán.', 'error');
    }
  });

}
 
function setupReports() {
  document.getElementById('btn-save-report')?.addEventListener('click', async () => {
    const slotId = document.getElementById('modal-report')?.dataset.slotId ?? '';
    const slotMeta = getSlotMetaById(slotId);
    if (!slotMeta) {
      toast('No se encontro el turno para guardar el reporte.', 'error');
      return;
    }
 
    const existing = state.reports.find((report) => report.slotId === slotId);
    const report = {
      ...(existing ?? {}),
      slotId,
      day: slotMeta.day,
      time: slotMeta.slot.time,
      point: getSelectedPoint()?.name ?? '',
      participants: getPeopleNames(slotMeta.slot),
      date: document.getElementById('report-date')?.value || new Date().toISOString().slice(0, 10),
      startTime: document.getElementById('report-start-time')?.value || '',
      fulfilled: document.getElementById('report-fulfilled')?.value === 'true',
      conversation: document.getElementById('report-conversation')?.value === 'true',
      studies: parseNonNegativeInt(document.getElementById('report-studies')?.value),
      notes: (document.getElementById('report-notes')?.value.trim() ?? '').slice(0, 500),
      updatedAt: Date.now()
    };
 
    if (!report.id) {
      report.id = `${slotId}-${Date.now()}`;
      report.createdAt = Date.now();
    }
 
    const nextReports = existing
      ? state.reports.map((item) => (item.slotId === slotId ? report : item))
      : [...state.reports, report];
 
    try {
      const result = await DB.setReports(state.selectedPointId, nextReports);
      if (!result.ok) {
        toast('No se pudo guardar el reporte.', 'error');
        return;
      }
 
      toast('Reporte guardado.', result.offline ? 'warning' : 'success');
      closeAllModals();
    } catch (error) {
      console.error(error);
      toast('No se pudo guardar el reporte.', 'error');
    }
  });
 
  document.getElementById('btn-download-report')?.addEventListener('click', async () => {
    const slotId = document.getElementById('modal-report')?.dataset.slotId ?? '';
    const report = state.reports.find((item) => item.slotId === slotId);
 
    if (!report) {
      toast('Guarda primero el reporte para descargarlo.', 'error');
      return;
    }
 
    try {
      await generatePDF([report], 'download');
      toast('PDF generado.', 'success');
    } catch (error) {
      console.error(error);
      toast('No se pudo generar el PDF.', 'error');
    }
  });
 
  document.getElementById('btn-remove-report')?.addEventListener('click', async () => {
    const slotId = document.getElementById('modal-report')?.dataset.slotId ?? '';
    if (!slotId) return;
 
    const ok = await confirm('Eliminar reporte de este turno?');
    if (!ok) return;
 
    try {
      const nextReports = state.reports.filter((item) => item.slotId !== slotId);
      const result = await DB.setReports(state.selectedPointId, nextReports);
      if (!result.ok) {
        toast('No se pudo eliminar el reporte.', 'error');
        return;
      }
 
      toast('Reporte eliminado.', result.offline ? 'warning' : 'success');
      closeAllModals();
    } catch (error) {
      console.error(error);
      toast('No se pudo eliminar el reporte.', 'error');
    }
  });
}
 
function syncAccessGateBanner() {
  const el = document.getElementById('access-gate-banner');
  if (!el) return;
  if (!state.authUser || isAdmin(state.profile)) {
    el.style.display = 'none';
    el.textContent = '';
    return;
  }
  if (state.profile?.adminApproved === false) {
    el.style.display = '';
    el.textContent =
      'Tu cuenta esta pendiente de activacion por el super de servicio. Cuando te active, podras usar tablero, reservas y participantes.';
    return;
  }
  el.style.display = 'none';
  el.textContent = '';
}

async function handleApproveReservationRequest(day, slot, targetUserId) {
  if (!state.authUser || !canManageSlots(state.profile, state.selectedPointId)) return;
  const result = await DB.setReservationRequestDecision({
    pointId: state.selectedPointId,
    day,
    time: slot.time,
    targetUserId,
    approve: true,
    actor: {
      uid: state.authUser.uid,
      role: state.profile?.role,
      assignedPointIds: state.profile?.assignedPointIds ?? []
    }
  });
  if (!result.ok) {
    toast(result.error ?? 'No se pudo aprobar.', 'error');
    return;
  }
  toast('Solicitud aprobada; ya figura en el tablero.', result.offline ? 'warning' : 'success');
  render();
}

async function handleRejectReservationRequest(day, slot, targetUserId) {
  if (!state.authUser || !canManageSlots(state.profile, state.selectedPointId)) return;
  const ok = await confirm('Rechazar esta solicitud de turno?');
  if (!ok) return;
  const result = await DB.setReservationRequestDecision({
    pointId: state.selectedPointId,
    day,
    time: slot.time,
    targetUserId,
    approve: false,
    actor: {
      uid: state.authUser.uid,
      role: state.profile?.role,
      assignedPointIds: state.profile?.assignedPointIds ?? []
    }
  });
  if (!result.ok) {
    toast(result.error ?? 'No se pudo rechazar.', 'error');
    return;
  }
  toast('Solicitud rechazada.', result.offline ? 'warning' : 'success');
  render();
}

function render() {
  renderDirty = true;
  if (renderQueued) return;
  renderQueued = true;
  queueMicrotask(() => {
    renderQueued = false;
    while (renderDirty) {
      renderDirty = false;
      renderImpl();
    }
  });
}

function renderImpl() {
  syncAccessBadges();
  syncAccessGateBanner();
  applyAppChrome();
  updateStats();
  renderHomeDirectory();
  renderHomeSelectionCard();
  renderParticipantsList();
  renderAdminLists();
  renderPendingApprovalAdminList();
  renderPermissionHints();
  syncSelectedSlotSummary();
  renderProfilePanel();
  syncHomePendingPanels();
  updateLoggedPickPointPanel();
  renderPendingApprovalList();

  UI.renderBoard(state.slots, openReserveFromBoard, {
    authUserId: state.authUser?.uid ?? '',
    canManageSlots: canManageSlots(state.profile, state.selectedPointId),
    onEdit: editSlot,
    onCancel: emptySlot,
    onReport: openReportModal,
    onApproveReservation: handleApproveReservationRequest,
    onRejectReservation: handleRejectReservationRequest,
    reportsBySlotId: buildReportsIndex()
  });
}
 
function renderHomeDirectory() {
  const list = document.getElementById('home-participant-list');
  if (!list) return;
 
  const filtered = getFilteredParticipantsDirectory();
  if (!filtered.some((participant) => participant.id === state.selectedDirectoryParticipantId)) {
    state.selectedDirectoryParticipantId = filtered[0]?.id ?? '';
  }
 
  renderSelectOptions(
    list,
    filtered.map((participant) => ({
      value: participant.id,
      label: `${participant.name} · ${participant.pointName}${participant.phone ? ` · ${participant.phone}` : ''}`
    }))
  );
 
  list.value = state.selectedDirectoryParticipantId || '';
  list.disabled = !filtered.length;

  const countEl = document.getElementById('home-participant-count');
  if (countEl) {
    countEl.textContent = filtered.length
      ? `${filtered.length} participante(s) en la lista`
      : 'Sin resultados con el filtro actual.';
  }

  const searchInput = document.getElementById('home-participant-search');
  if (searchInput && document.activeElement !== searchInput) {
    searchInput.value = state.participantQuery;
  }
 
  renderHomeSelectionCard();
}
 
function renderHomeSelectionCard() {
  const participant = getSelectedDirectoryParticipant();
  const nameNode = document.getElementById('home-participant-name');
  const pointNode = document.getElementById('home-participant-point');
  const phoneNode = document.getElementById('home-participant-phone');
  const goReserve = document.getElementById('btn-home-go-reserve');
  const goPeople = document.getElementById('btn-home-go-people');
  const goBoard = document.getElementById('btn-home-go-board');
 
  const hasSelection = Boolean(participant);
  if (nameNode) nameNode.textContent = participant?.name ?? 'Sin seleccion';
  if (pointNode) pointNode.textContent = participant
    ? `Punto: ${participant.pointName}`
    : 'Selecciona un participante para ver su punto.';
  if (phoneNode) phoneNode.textContent = participant?.phone
    ? `Telefono: ${participant.phone}`
    : '';
 
  [goReserve, goPeople, goBoard].forEach((button) => {
    if (button) button.disabled = !hasSelection;
  });
}
 
function getFilteredParticipantsDirectory() {
  const query = state.participantQuery.trim().toLowerCase();
  if (!query) return state.participantsDirectory;
 
  return state.participantsDirectory.filter((participant) => {
    const haystack = [
      participant.name,
      participant.phone,
      participant.pointName
    ].join(' ').toLowerCase();
    return haystack.includes(query);
  });
}
 
function getSelectedDirectoryParticipant() {
  if (!state.selectedDirectoryParticipantId) return null;
  return state.participantsDirectory.find(
    (participant) => participant.id === state.selectedDirectoryParticipantId
  ) ?? null;
}
 
function goToHomeDestination(destination) {
  if (state.authUser && !canUseAppDataProfile()) {
    toast('Tu acceso a turnos y tablero aun no esta activo.', 'info');
    return;
  }
  const participant = getSelectedDirectoryParticipant();
  if (!participant) {
    toast('Selecciona un participante para continuar.', 'error');
    return;
  }
 
  const shouldSwitchPoint = participant.pointId !== state.selectedPointId;

  const tabByDestination = {
    reserve: '.nav-tab[data-view="reserve"]',
    people: '.nav-tab[data-view="people"]',
    board: '.nav-tab[data-view="board"]'
  };
  const navigateToTargetTab = () => {
    document.querySelector(tabByDestination[destination])?.click();
  };

  if (shouldSwitchPoint) {
    pendingHomeDestination = destination;
    switchPoint(participant.pointId, { keepPendingHomeDestination: true });
  } else {
    navigateToTargetTab();
  }
 
  if (destination === 'reserve') {
    state.pendingReserveParticipantName = participant.name;
    setValue('sel-participant', participant.name);
    syncSelectedSlotSummary();
  }
}
 
function updateStats() {
  let partial = 0;
  let complete = 0;
 
  Object.values(state.slots).forEach((daySlots) => {
    daySlots?.forEach((slot) => {
      if (slot.status === 'partial' || slot.status === 'ready') partial += 1;
      if (slot.status === 'complete') complete += 1;
    });
  });
 
  setText('count-part', String(state.participants.length));
  setText('count-point', String(state.visiblePoints.length));
  setText('count-parti', String(partial));
  setText('count-comp', String(complete));
}

function populateReassignModal(payload) {
  setText('reassign-from-point', payload?.from?.pointName ?? 'Punto actual');
  setText(
    'reassign-from-subadmin',
    payload?.from?.subadminName
      ? `Capitán: ${payload.from.subadminName}`
      : 'Sin capitán asignado'
  );
  setText('reassign-to-point', payload?.to?.pointName ?? 'Nuevo punto');
  setText(
    'reassign-to-subadmin',
    payload?.to?.subadminName
      ? `Capitán: ${payload.to.subadminName}`
      : 'Sin capitán asignado'
  );
  setText(
    'reassign-summary',
    `Ya tienes reservas activas fuera de ${payload?.to?.pointName ?? 'este punto'}. Si continuas, se cancelaran antes de guardar la nueva reserva.`
  );

  const affectedList = document.getElementById('reassign-affected-list');
  if (!affectedList) return;

  const rows = Array.isArray(payload?.affectedReservations) ? payload.affectedReservations : [];
  affectedList.innerHTML = '';

  if (!rows.length) {
    const empty = document.createElement('li');
    empty.className = 'reassign-affected-empty';
    empty.textContent = 'No se detectaron reservas a cancelar.';
    affectedList.appendChild(empty);
    return;
  }

  rows.forEach((reservation) => {
    const item = document.createElement('li');
    item.className = 'reassign-affected-item';
    item.textContent = `${reservation.day} ${reservation.time} - ${reservation.pointName || reservation.pointId}`;
    affectedList.appendChild(item);
  });
}
 
function renderParticipantsList() {
  const list = document.getElementById('participants-list');
  if (!list) return;
 
  list.innerHTML = '';
 
  if (!state.participants.length) {
    const empty = document.createElement('li');
    empty.className = 'list-empty';
    empty.textContent = 'Sin participantes en este punto.';
    list.appendChild(empty);
    return;
  }
 
  state.participants.forEach((participant, index) => {
    const item = document.createElement('li');
    item.className = 'admin-list-item';

    const main = document.createElement('div');
    main.className = 'admin-list-item__main';

    const label = document.createElement('span');
    label.textContent = participant.phone
      ? `${participant.name} (${participant.phone})`
      : participant.name;
    main.appendChild(label);

    const prefDay = String(participant.preferredDay ?? '').trim();
    const prefTime = String(participant.preferredTime ?? '').trim();
    if (prefDay || prefTime) {
      const prefLine = document.createElement('span');
      prefLine.className = 'view-muted';
      prefLine.style.fontSize = '.8rem';
      prefLine.textContent = `Preferencia: ${[prefDay, prefTime].filter(Boolean).join(' · ')}`;
      main.appendChild(prefLine);
    }

    item.appendChild(main);
 
    if (canEditParticipants(state.profile, state.selectedPointId)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn-delete-item';
      button.dataset.index = String(index);
      button.textContent = 'Eliminar';
      button.addEventListener('click', async () => {
        const ok = await confirm(`Eliminar participante ${participant.name}?`);
        if (!ok) return;
 
        try {
          const nextParticipants = state.participants.filter((_, currentIndex) => currentIndex !== index);
          const result = await DB.setParticipants(state.selectedPointId, nextParticipants);
          if (!result.ok) {
            toast('No se pudo eliminar el participante.', 'error');
            return;
          }
          toast('Participante eliminado.', result.offline ? 'warning' : 'success');
        } catch (error) {
          console.error(error);
          toast('No se pudo eliminar el participante.', 'error');
        }
      });
      item.appendChild(button);
    }
 
    list.appendChild(item);
  });
}
 
function renderPendingApprovalAdminList() {
  const pend = document.getElementById('list-pending-approval');
  if (pend && canManagePoints(state.profile)) {
    pend.innerHTML = '';
    const pending = state.users.filter(
      (u) => u.adminApproved === false && u.role !== ROLES.ADMIN
    );
    if (!pending.length) {
      const li = document.createElement('li');
      li.className = 'list-empty';
      li.textContent = 'No hay cuentas pendientes de aprobacion.';
      pend.appendChild(li);
    } else {
      pending.forEach((u) => {
        const item = document.createElement('li');
        item.className = 'admin-list-item';
        const label = document.createElement('span');
        const em = String(u.email ?? '').trim() || u.id;
        label.textContent = `${em} (${u.id})`;
        item.appendChild(label);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn-primary';
        button.textContent = 'Aprobar acceso';
        button.addEventListener('click', async () => {
          try {
            await DB.saveUserProfile(u.id, { adminApproved: true });
            toast('Usuario aprobado.', 'success');
          } catch (error) {
            console.error(error);
            toast('No se pudo aprobar.', 'error');
          }
        });
        item.appendChild(button);
        pend.appendChild(item);
      });
    }
  }
}

function renderAdminLists() {
  const pointsList = document.getElementById('list-points');
  if (!pointsList) return;
 
  pointsList.innerHTML = '';
 
  if (!state.points.length) {
    const empty = document.createElement('li');
    empty.className = 'list-empty';
    empty.textContent = 'Sin puntos.';
    pointsList.appendChild(empty);
    return;
  }
 
  state.points.forEach((point) => {
    const item = document.createElement('li');
    item.className = 'admin-list-item';
 
    const label = document.createElement('span');
    label.textContent = point.name;
 
    const meta = document.createElement('small');
    meta.textContent = ` (${point.id})`;
    label.appendChild(meta);
    item.appendChild(label);
 
    if (canManagePoints(state.profile)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn-delete-item';
      button.dataset.id = point.id;
      button.textContent = 'Eliminar';
      button.addEventListener('click', async () => {
        const ok = await confirm(`Eliminar el punto ${point.name} y todos sus datos?`);
        if (!ok) return;
 
        try {
          await DB.deletePoint(point.id);
          toast('Punto eliminado.', 'success');
        } catch (error) {
          console.error(error);
          toast('No se pudo eliminar el punto.', 'error');
        }
      });
      item.appendChild(button);
    }
 
    pointsList.appendChild(item);
  });
}
 
function renderPermissionHints() {
  const participantHint = document.getElementById('participants-permission-hint');
  if (participantHint) {
    participantHint.textContent = canEditParticipants(state.profile, state.selectedPointId)
      ? 'Puedes agregar y eliminar participantes del punto seleccionado.'
      : 'Modo lectura: los publicadores no pueden agregar participantes.';
  }
}
 
function openReserveFromBoard(day, slot) {
  openTab('reserve');
  setValue('select-day', day);
  setValue('select-time', slot.time);
  syncSelectedSlotSummary();
}
 
function openReportModal(day, slot) {
  if (!canManageSlots(state.profile, state.selectedPointId)) {
    toast('No tienes permisos para reportar turnos de este punto.', 'error');
    return;
  }
 
  const modal = document.getElementById('modal-report');
  if (!modal) return;
 
  const existing = state.reports.find((report) => report.slotId === slot.id);
  modal.dataset.slotId = slot.id;
 
  setText(
    'report-slot-label',
    `${day} ${slot.time} · ${getSelectedPoint()?.name ?? ''} · Publicadores: ${getPeopleNames(slot).join(', ') || '-'}`
  );
 
  setValue('report-date', existing?.date ?? new Date().toISOString().slice(0, 10));
  setValue('report-start-time', existing?.startTime ?? '');
  setValue('report-fulfilled', String(existing?.fulfilled ?? true));
  setValue('report-conversation', String(existing?.conversation ?? false));
  setValue('report-studies', String(existing?.studies ?? 0));
  setValue('report-notes', existing?.notes ?? '');
  openModal('modal-report');
}
 
async function emptySlot(day, slot) {
  if (!canManageSlots(state.profile, state.selectedPointId)) {
    toast('No puedes editar turnos de este punto.', 'error');
    return;
  }

  const ok = await confirm(`Vaciar turno ${day} ${slot.time}?`);
  if (!ok) return;

  const target = state.slots[day]?.find((item) => item.id === slot.id);
  if (!target) return;

  const slotsBefore = structuredClone(state.slots);
  cancelSlot(target);

  try {
    const result = await DB.setSlots(state.selectedPointId, state.slots);
    if (!result.ok) {
      state.slots = slotsBefore;
      toast('No se pudo vaciar el turno.', 'error');
      return;
    }

    toast('Turno vaciado.', result.offline ? 'warning' : 'success');
  } catch (error) {
    console.error(error);
    state.slots = slotsBefore;
    toast('No se pudo vaciar el turno.', 'error');
  }
}
 
async function editSlot(day, slot) {
  const canManageSelectedPoint = canManageSlots(state.profile, state.selectedPointId);
  const ownReservation = (slot.reservations ?? []).find((reservation) =>
    canManageReservation(state.profile, state.selectedPointId, reservation, state.authUser)
  );
 
  if (!canManageSelectedPoint && !ownReservation) {
    toast('No puedes editar turnos de este punto.', 'error');
    return;
  }
 
  if (!canManageSelectedPoint) {
    const ok = await confirm(`Cancelar tu reserva de ${day} ${slot.time}?`);
    if (!ok) return;
 
    const result = await DB.cancelOwnReservation({
      pointId: state.selectedPointId,
      day,
      time: slot.time,
      actor: { uid: state.authUser?.uid ?? '' }
    });
 
    if (!result.ok) {
      toast(result.error ?? 'No se pudo cancelar la reserva.', 'error');
      return;
    }
 
    toast('Tu reserva fue cancelada.', result.offline ? 'warning' : 'success');
    return;
  }
 
  const names = (slot.reservations ?? []).map((reservation) => reservation.name).filter(Boolean);
  if (!names.length) return;

  const target = state.slots[day]?.find((item) => item.id === slot.id);
  if (!target) return;

  const selectedName = await promptInput(
    `Reserva actual: ${names.join(', ')}. Escribe el nombre principal a eliminar:`
  );
  if (!selectedName) return;

  const targetName = normalizeName(selectedName);
  const matchingIndices = target.reservations
    .map((reservation, index) => ({ index, reservation }))
    .filter(({ reservation }) => normalizeName(reservation.name) === targetName)
    .map(({ index }) => index);

  if (!matchingIndices.length) {
    toast('No se encontro esa reserva principal.', 'error');
    return;
  }

  let reservationIndex = matchingIndices[0];
  if (matchingIndices.length > 1) {
    const lines = matchingIndices.map((idx, k) => {
      const r = target.reservations[idx];
      const uid = String(r.userId ?? '').trim();
      const hint = uid ? ` · id ${uid.slice(0, 8)}…` : '';
      return `${k + 1}) ${r.name}${hint}`;
    });
    const pick = await promptInput(
      `Hay varias reservas con ese nombre. Escribe el numero (1-${matchingIndices.length}):\n${lines.join('\n')}`
    );
    const n = Number.parseInt(String(pick ?? '').trim(), 10);
    if (!Number.isFinite(n) || n < 1 || n > matchingIndices.length) {
      toast('Numero invalido.', 'error');
      return;
    }
    reservationIndex = matchingIndices[n - 1];
  }

  const slotsBefore = structuredClone(state.slots);
  const targetMut = state.slots[day]?.find((item) => item.id === slot.id);
  if (!targetMut) return;

  // Usar removeReservation para centralizar la lógica de eliminación por nombre.
  // reservationIndex apunta a la reserva seleccionada por el usuario; buscamos
  // el nombre exacto en esa posición para pasárselo a la función unificada.
  const nameToRemove = targetMut.reservations[reservationIndex]?.name ?? '';
  const removeResult = removeReservation(targetMut, nameToRemove);
  if (!removeResult.ok) {
    toast(removeResult.error, 'error');
    return;
  }

  try {
    const result = await DB.setSlots(state.selectedPointId, state.slots);
    if (!result.ok) {
      state.slots = slotsBefore;
      toast('No se pudo eliminar la reserva.', 'error');
      return;
    }
    toast('Reserva eliminada.', result.offline ? 'warning' : 'success');
  } catch (error) {
    console.error(error);
    state.slots = slotsBefore;
    toast('No se pudo eliminar la reserva.', 'error');
  }
}
 
function getSelectedPoint() {
  return state.points.find((point) => point.id === state.selectedPointId) ?? null;
}
 
function getSlotMetaById(slotId) {
  for (const day of DAYS) {
    const slot = state.slots[day]?.find((item) => item.id === slotId);
    if (slot) return { day, slot };
  }
  return null;
}
 
function buildReportsIndex() {
  return state.reports.reduce((acc, report) => {
    if (report?.slotId) acc[report.slotId] = report;
    return acc;
  }, {});
}
 
function setText(id, value) {
  const node = document.getElementById(id);
  if (node) node.textContent = value;
}
 
function setValue(id, value) {
  const node = document.getElementById(id);
  if (node) node.value = value;
}
 
function normalizeName(value) {
  return String(value ?? '').trim().toLowerCase();
}
 
function parseNonNegativeInt(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) return 0;
  return Math.max(0, parsed);
}
 
function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Asignar capitán: UID manual o solo correo si ya existe `users/{uid}` (al menos un login).
 * @returns {{ uid: string, email: string, displayName: string } | { error: string }}
 */
function resolveCaptainAssignTarget(uidRaw, emailRaw, displayNameRaw) {
  const uidTrim = String(uidRaw ?? '').trim();
  const emailTrim = String(emailRaw ?? '').trim();
  const nameTrim = String(displayNameRaw ?? '').trim();

  if (uidTrim) {
    const fromState = state.users.find((u) => u.id === uidTrim);
    const emailOut = emailTrim || String(fromState?.email ?? '').trim();
    const nameOut =
      nameTrim || String(fromState?.displayName ?? '').trim() || emailOut || uidTrim;
    return {
      uid: uidTrim,
      email: emailOut,
      displayName: nameOut
    };
  }

  if (!emailTrim || !isValidEmail(emailTrim)) {
    return {
      error:
        'Pega el UID del capitán (Firebase → Authentication → usuario) o su correo si ya entro al menos una vez a PredicApp.'
    };
  }

  const key = normalizeAuthEmailForAllowlist(emailTrim);
  const matches = state.users.filter(
    (u) => normalizeAuthEmailForAllowlist(u.email) === key
  );

  if (matches.length === 1) {
    const u = matches[0];
    return {
      uid: u.id,
      email: emailTrim,
      displayName: nameTrim || String(u.displayName ?? '').trim() || emailTrim
    };
  }

  if (matches.length > 1) {
    return { error: 'Hay varios perfiles con ese correo; usa el UID para desambiguar.' };
  }

  return {
    error:
      'No hay perfil con ese correo. El capitán debe iniciar sesion una vez en PredicApp, o indica su UID desde Firebase Console → Authentication.'
  };
}
 
function renderSelectOptions(selectNode, options) {
  if (!selectNode) return;

  const frag = document.createDocumentFragment();
  for (let i = 0; i < options.length; i += 1) {
    const option = options[i];
    const optionNode = document.createElement('option');
    optionNode.value = option.value;
    optionNode.textContent = option.label;
    frag.appendChild(optionNode);
  }
  selectNode.replaceChildren(frag);
}
 
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
 
  window.addEventListener('load', async () => {
    try {
      const buildTag = document.body?.dataset?.build || 'predicapp-v14';
      const key = 'predicapp-build-tag';
      const prevBuild = localStorage.getItem(key);

      // Al cambiar build, limpiamos SW/cache para evitar mezcla de assets viejos.
      if (prevBuild && prevBuild !== buildTag) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((reg) => reg.unregister()));

        if ('caches' in window) {
          const keys = await caches.keys();
          await Promise.all(
            keys
              .filter((cacheKey) => cacheKey.startsWith('predicapp-'))
              .map((cacheKey) => caches.delete(cacheKey))
          );
        }

        localStorage.setItem(key, buildTag);
        window.location.reload();
        return;
      }

      localStorage.setItem(key, buildTag);
      const registration = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
      await registration.update();
    } catch (error) {
      console.warn('No se pudo registrar el service worker.', error);
    }
  });
    }
    
