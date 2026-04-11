// ─────────────────────────────────────────────
//  app.js  —  Controlador principal
//  Mejoras: sin window.*, sin alert/prompt,
//           estado centralizado, delegación
//           de eventos, lógica en servicios
// ─────────────────────────────────────────────

import { DB, initDB }           from './db.js';
import { UI }                   from './ui.js';
import { addReservation }       from './reservations.js';
import { verifyPassword, changePassword } from './auth.js';
import { toast, confirm, promptInput }   from './toast.js';
import { FULL_DAY_NAMES }       from './config.js';

// ── Estado de la aplicación ───────────────────────────────────
const state = {
  slots:        {},
  points:       [],
  participants: [],
  currentSlot:  null,   // { day, slot }
  isAdmin:      false
};

// ── Inicialización ────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initDB();
  loadState();
  renderAll();
  bindEvents();
  registerPWA();
});

function loadState() {
  state.slots        = DB.get('slots', {});
  state.points       = DB.get('points', []);
  state.participants = DB.get('participants', []);
}

function renderAll() {
  UI.renderBoard(state.slots, handleOpenReserve);
  document.getElementById('count-part').textContent  = state.participants.length;
  document.getElementById('count-point').textContent = state.points.length;
}

// ── Binding de eventos ────────────────────────────────────────
function bindEvents() {
  bindNavTabs();
  bindModalClose();
  bindReserveForm();
  bindParticipantForm();
  bindAdminPanel();
  bindStorageSync();
}

// Navegación
function bindNavTabs() {
  const VIEW_MODAL_MAP = {
    reserve: 'modal-reserve',
    people:  'modal-participant',
    admin:   'modal-admin'
  };

  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const modalId = VIEW_MODAL_MAP[tab.dataset.view];
      if (modalId) {
        if (tab.dataset.view === 'admin') {
          renderAdminModal();
        }
        UI.toggleModal(modalId, true);
      }
    });
  });
}

// Cierre de modales (delegación de eventos)
function bindModalClose() {
  document.addEventListener('click', e => {
    if (e.target.matches('.close-btn, .close-modal')) {
      document.querySelectorAll('.modal').forEach(m => m.classList.remove('active'));
    }
    // Clic en el fondo oscuro del modal
    if (e.target.matches('.modal')) {
      e.target.classList.remove('active');
    }
  });

  // Cerrar con Escape
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal.active').forEach(m => m.classList.remove('active'));
    }
  });
}

// ── Reservas ──────────────────────────────────────────────────
function handleOpenReserve(day, slot) {
  state.currentSlot = { day, slot };

  UI.fillSelect(
    'sel-participant',
    state.participants,
    p => p.name,
    p => p.name
  );

  UI.fillSelect(
    'sel-point',
    state.points,
    p => p,
    p => p
  );

  // FULL_DAY_NAMES ya está importado estáticamente en config.js
  document.getElementById('res-info').value = `${FULL_DAY_NAMES[day] ?? day} — ${slot.time}`;

  UI.toggleModal('modal-reserve', true);
}

function bindReserveForm() {
  document.getElementById('btn-confirm-reserve').addEventListener('click', async () => {
    const name  = document.getElementById('sel-participant').value;
    const point = document.getElementById('sel-point').value;

    if (!state.currentSlot) return;
    const { slot } = state.currentSlot;

    const result = addReservation(slot, name, point);

    if (!result.ok) {
      toast(result.error, 'error');
      return;
    }

    DB.set('slots', state.slots);
    UI.renderBoard(state.slots, handleOpenReserve);
    UI.toggleModal('modal-reserve', false);
    toast('Turno reservado correctamente', 'success');
  });
}

// ── Participantes ─────────────────────────────────────────────
function bindParticipantForm() {
  document.getElementById('btn-save-part').addEventListener('click', () => {
    const nameEl  = document.getElementById('inp-part-name');
    const phoneEl = document.getElementById('inp-part-phone');
    const name  = nameEl.value.trim();
    const phone = phoneEl.value.trim();

    if (!name) {
      toast('El nombre es obligatorio', 'error');
      nameEl.focus();
      return;
    }

    // Evitar duplicados
    if (state.participants.some(p => p.name.toLowerCase() === name.toLowerCase())) {
      toast(`"${name}" ya está en la lista`, 'warning');
      return;
    }

    state.participants.push({ name, phone });
    DB.set('participants', state.participants);
    document.getElementById('count-part').textContent = state.participants.length;

    nameEl.value  = '';
    phoneEl.value = '';
    UI.toggleModal('modal-participant', false);
    toast('Participante guardado', 'success');
  });
}

// ── Panel Admin ───────────────────────────────────────────────
function bindAdminPanel() {
  // Login
  document.getElementById('btn-admin-login').addEventListener('click', async () => {
    // Usamos nuestro promptInput en vez de prompt()
    const pass = await promptInput('Contraseña de encargado:', '••••••');
    if (pass === null) return; // canceló

    const ok = await verifyPassword(pass);
    if (!ok) {
      toast('Contraseña incorrecta', 'error');
      return;
    }

    state.isAdmin = true;
    document.getElementById('tab-admin').style.display = 'block';
    document.getElementById('role-badge').style.display = 'inline';
    toast('Sesión de encargado iniciada', 'success');
  });

  // Agregar punto
  document.getElementById('btn-add-point').addEventListener('click', async () => {
    const nombre = await promptInput('Nombre del nuevo punto de predicación:');
    if (!nombre) return;

    if (state.points.includes(nombre)) {
      toast(`"${nombre}" ya existe`, 'warning');
      return;
    }

    state.points.push(nombre);
    DB.set('points', state.points);
    document.getElementById('count-point').textContent = state.points.length;
    UI.renderAdminList('list-points', state.points, handleDeletePoint);
    toast('Punto agregado', 'success');
  });

  // Cambiar contraseña
  document.getElementById('btn-change-pass').addEventListener('click', async () => {
    const oldPass = document.getElementById('old-pass').value;
    const newPass = document.getElementById('new-pass').value;

    const result = await changePassword(oldPass, newPass);
    if (!result.ok) {
      toast(result.error, 'error');
      return;
    }

    document.getElementById('old-pass').value = '';
    document.getElementById('new-pass').value = '';
    toast('Contraseña actualizada correctamente', 'success');
  });

  // Abrir modal participante desde admin
  document.getElementById('btn-open-add-part')?.addEventListener('click', () => {
    UI.toggleModal('modal-participant', true);
  });
}

function renderAdminModal() {
  UI.renderAdminList('list-points', state.points, handleDeletePoint);
  UI.renderAdminList('list-parts',  state.participants, handleDeleteParticipant);
}

async function handleDeletePoint(point, index) {
  const ok = await confirm(`¿Eliminar el punto "${point}"?`);
  if (!ok) return;

  state.points.splice(index, 1);
  DB.set('points', state.points);
  document.getElementById('count-point').textContent = state.points.length;
  UI.renderAdminList('list-points', state.points, handleDeletePoint);
  toast(`Punto "${point}" eliminado`, 'info');
}

async function handleDeleteParticipant(participant, index) {
  const name = participant.name ?? participant;
  const ok = await confirm(`¿Eliminar a "${name}" de la lista?`);
  if (!ok) return;

  state.participants.splice(index, 1);
  DB.set('participants', state.participants);
  document.getElementById('count-part').textContent = state.participants.length;
  UI.renderAdminList('list-parts', state.participants, handleDeleteParticipant);
  toast(`"${name}" eliminado`, 'info');
}

// ── Sincronización multi-pestaña ──────────────────────────────
function bindStorageSync() {
  window.addEventListener('storage', e => {
    if (!e.key?.startsWith('predicapp_')) return;
    // Recargar estado si otra pestaña modificó datos
    loadState();
    UI.renderBoard(state.slots, handleOpenReserve);
  });
}

// ── PWA ───────────────────────────────────────────────────────
function registerPWA() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(err => {
      console.warn('[SW] Registro fallido:', err);
    });
  }

  // Banner de instalación
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredPrompt = e;
    document.getElementById('btn-install').style.display = 'inline-block';
  });

  document.getElementById('btn-install')?.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') toast('¡App instalada!', 'success');
    deferredPrompt = null;
    document.getElementById('btn-install').style.display = 'none';
  });
}
