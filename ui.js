// ─────────────────────────────────────────────
//  ui.js  —  Capa de presentación
//  Mejoras: SRP, sin XSS (textContent),
//           DocumentFragment para rendimiento,
//           sin window.openReserve global,
//           mapa de días como constante externa
// ─────────────────────────────────────────────

import { DAYS, FULL_DAY_NAMES, TIMES } from './config.js';

// ── Helpers ───────────────────────────────────────────────────

/**
 * Crea un elemento con clases y texto opcionales.
 * Usa textContent — nunca innerHTML con datos de usuario.
 */
function el(tag, classes = '', text = '') {
  const e = document.createElement(tag);
  if (classes) e.className = classes;
  if (text)    e.textContent = text;
  return e;
}

// ── Módulo principal ──────────────────────────────────────────
export const UI = {

  /**
   * Renderiza el tablero completo.
   * Recibe un callback `onReserve(day, slot)` para desacoplar
   * la lógica de negocio de la presentación.
   *
   * @param {Object} slots
   * @param {Function} onReserve  — callback(day, slot)
   */
  renderBoard(slots, onReserve) {
    this._renderDesktopTable(slots, onReserve);
    this._renderMobileCards(slots, onReserve);
    this._updateStats(slots);
  },

  // ── Vista desktop ─────────────────────────────────────────
  _renderDesktopTable(slots, onReserve) {
    const tbody = document.getElementById('table-body');
    const fragment = document.createDocumentFragment();

    TIMES.forEach(time => {
      const tr = document.createElement('tr');

      // Columna de hora
      const tdTime = el('td', 'col-time');
      tdTime.appendChild(el('strong', '', time));
      tr.appendChild(tdTime);

      // Columna por día
      DAYS.forEach(day => {
        const slot = slots[day]?.find(s => s.time === time);
        const td = document.createElement('td');

        if (!slot) {
          td.textContent = '—';
          tr.appendChild(td);
          return;
        }

        const cell = this._buildSlotCell(slot, day, onReserve);
        td.appendChild(cell);
        tr.appendChild(td);
      });

      fragment.appendChild(tr);
    });

    tbody.innerHTML = '';
    tbody.appendChild(fragment);
  },

  _buildSlotCell(slot, day, onReserve) {
    const cell = el('div', `slot-cell ${slot.status}`);

    if (slot.reservations.length > 0) {
      slot.reservations.forEach(r => {
        // ✅ textContent — seguro contra XSS
        const name = el('span', 'res-name', r.name.split(' ')[0]);
        cell.appendChild(name);
      });
    } else {
      cell.textContent = '➕';
    }

    if (slot.status !== 'full') {
      cell.setAttribute('role', 'button');
      cell.setAttribute('tabindex', '0');
      cell.setAttribute('aria-label', `Reservar ${day} ${slot.time}`);
      cell.onclick = () => onReserve(day, slot);
      cell.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') onReserve(day, slot); };
    }

    return cell;
  },

  // ── Vista móvil ───────────────────────────────────────────
  _renderMobileCards(slots, onReserve) {
    const container = document.getElementById('mobile-cards');
    const fragment = document.createDocumentFragment();

    DAYS.forEach(day => {
      if (!slots[day]) return;

      const header = el('div', 'mobile-day-header', `📅 ${FULL_DAY_NAMES[day] ?? day}`);
      fragment.appendChild(header);

      slots[day].forEach(slot => {
        const card = this._buildSlotCard(slot, day, onReserve);
        fragment.appendChild(card);
      });
    });

    container.innerHTML = '';
    container.appendChild(fragment);
  },

  _buildSlotCard(slot, day, onReserve) {
    const card = el('div', `slot-card status-${slot.status}`);
    card.setAttribute('data-status', slot.status);

    const timeEl = el('span', 'card-time', slot.time);
    const dot    = el('span', `dot ${slot.status}`);
    const btn    = el('button', `btn-reserve${slot.status === 'full' ? ' btn-full' : ''}`);

    // ✅ textContent — seguro contra XSS
    btn.textContent = slot.status === 'full'
      ? 'Completo'
      : slot.reservations.length > 0 ? 'Ver / Reservar' : 'Reservar';

    btn.disabled = slot.status === 'full';
    btn.setAttribute('aria-label', `${btn.textContent} ${FULL_DAY_NAMES[day]} ${slot.time}`);

    if (slot.status !== 'full') {
      btn.onclick = () => onReserve(day, slot);
    }

    // Nombres de reservas existentes
    if (slot.reservations.length > 0) {
      const names = el('div', 'card-names');
      slot.reservations.forEach(r => {
        names.appendChild(el('span', 'card-res-name', r.name));
      });
      card.appendChild(timeEl);
      card.appendChild(names);
    } else {
      card.appendChild(timeEl);
    }

    card.appendChild(dot);
    card.appendChild(btn);
    return card;
  },

  // ── Contadores de stats ───────────────────────────────────
  _updateStats(slots) {
    let partial = 0, full = 0;

    Object.values(slots).forEach(daySlots => {
      daySlots.forEach(slot => {
        if (slot.status === 'full')    full++;
        else if (slot.status === 'partial') partial++;
      });
    });

    document.getElementById('count-parti').textContent = partial;
    document.getElementById('count-comp').textContent  = full;
  },

  // ── Modales ───────────────────────────────────────────────
  toggleModal(id, show) {
    const modal = document.getElementById(id);
    if (!modal) {
      console.warn(`[UI] Modal no encontrado: ${id}`);
      return;
    }
    modal.classList.toggle('active', show);

    // Accesibilidad: foco al primer campo cuando se abre
    if (show) {
      const focusable = modal.querySelector('input, select, button:not(.close-btn)');
      focusable?.focus();
    }
  },

  // ── Selectores ────────────────────────────────────────────
  /**
   * Llena un <select> con opciones a partir de un array.
   * @param {string} selectId
   * @param {Array} items
   * @param {Function} labelFn  — (item) => string
   * @param {Function} valueFn  — (item) => string
   */
  fillSelect(selectId, items, labelFn, valueFn) {
    const sel = document.getElementById(selectId);
    if (!sel) return;

    const fragment = document.createDocumentFragment();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Selecciona...';
    fragment.appendChild(placeholder);

    items.forEach(item => {
      const opt = document.createElement('option');
      // ✅ textContent — seguro contra XSS
      opt.value       = valueFn(item);
      opt.textContent = labelFn(item);
      fragment.appendChild(opt);
    });

    sel.innerHTML = '';
    sel.appendChild(fragment);
  },

  // ── Lista admin ───────────────────────────────────────────
  /**
   * Renderiza una lista en el panel admin.
   * @param {string} listId
   * @param {Array<string>} items
   * @param {Function} [onDelete]  — callback(item, index) opcional
   */
  renderAdminList(listId, items, onDelete) {
    const list = document.getElementById(listId);
    if (!list) return;

    const fragment = document.createDocumentFragment();

    if (items.length === 0) {
      const empty = el('li', 'list-empty', 'Sin elementos todavía.');
      fragment.appendChild(empty);
    } else {
      items.forEach((item, i) => {
        const li = el('li', 'admin-list-item');
        li.appendChild(el('span', 'item-label', typeof item === 'object' ? item.name : item));

        if (onDelete) {
          const btn = el('button', 'btn-delete-item', '🗑');
          btn.setAttribute('aria-label', `Eliminar ${item}`);
          btn.onclick = () => onDelete(item, i);
          li.appendChild(btn);
        }

        fragment.appendChild(li);
      });
    }

    list.innerHTML = '';
    list.appendChild(fragment);
  }
};
