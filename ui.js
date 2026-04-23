import { DAYS, FULL_DAY_NAMES, MAX_RESERVATIONS_PER_SLOT, TIMES } from './config.js?v=4.2';
import {
  countPeople,
  getPendingReservations,
  getPeopleNames,
  getSlotPoint
} from './reservations.js';

function el(tag, classes = '', text = '') {
  const node = document.createElement(tag);
  if (classes) node.className = classes;
  if (text) node.textContent = text;
  return node;
}

export const UI = {
  renderBoard(slots, onReserve, opts = {}) {
    this.renderDesktopTable(slots, onReserve, opts);
    this.renderMobileCards(slots, onReserve, opts);
  },

  renderDesktopTable(slots, onReserve, opts) {
    const tbody = document.getElementById('table-body');
    if (!tbody) return;

    const anchorDay = DAYS.find((d) => Array.isArray(slots[d]) && slots[d].length > 0);
    const times = anchorDay
      ? slots[anchorDay].map((slot) => slot.time)
      : [...TIMES];
    const fragment = document.createDocumentFragment();

    times.forEach((time) => {
      const row = document.createElement('tr');
      row.appendChild(el('td', 'td-time', time));

      DAYS.forEach((day) => {
        const slot = slots[day]?.find((item) => item.time === time);
        const cell = document.createElement('td');
        cell.appendChild(
          slot
            ? this.buildSlotCell(slot, day, onReserve, opts)
            : el('span', 'td-empty', '-')
        );
        row.appendChild(cell);
      });

      fragment.appendChild(row);
    });

    tbody.innerHTML = '';
    tbody.appendChild(fragment);
  },

  buildSlotCell(slot, day, onReserve, opts) {
    const cell = el('div', `slot-cell ${slot.status}`);
    const people = countPeople(slot);
    const names = getPeopleNames(slot, true);
    const point = getSlotPoint(slot);
    const pendingList = getPendingReservations(slot);

    cell.appendChild(el('div', 'slot-count', `Confirmados ${people}/${MAX_RESERVATIONS_PER_SLOT}`));

    if (point) {
      cell.appendChild(el('div', 'slot-names', `Punto: ${point}`));
    }

    if (names.length) {
      cell.appendChild(el('div', 'slot-names', names.join(', ')));
    }

    if (opts.canManageSlots && pendingList.length) {
      const wrap = el('div', 'slot-pending');
      pendingList.forEach((pr) => {
        const row = el('div', 'slot-pending-row');
        row.appendChild(el('span', 'slot-pending-label', `${pr.name} · solicitud pendiente`));
        const ap = el('button', 'slot-btn-admin', 'Aprobar');
        ap.onclick = (event) => {
          event.stopPropagation();
          opts.onApproveReservation?.(day, slot, pr.userId);
        };
        const rj = el('button', 'slot-btn-admin slot-btn-cancel', 'Rechazar');
        rj.onclick = (event) => {
          event.stopPropagation();
          opts.onRejectReservation?.(day, slot, pr.userId);
        };
        row.appendChild(ap);
        row.appendChild(rj);
        wrap.appendChild(row);
      });
      cell.appendChild(wrap);
    }

    if (opts.reportsBySlotId?.[slot.id]) {
      cell.appendChild(el('div', 'slot-names', '📋 Reporte guardado'));
    }

    if (people < MAX_RESERVATIONS_PER_SLOT) {
      const reserveButton = el('button', 'slot-btn-reserve', 'Reservar');
      reserveButton.onclick = (event) => {
        event.stopPropagation();
        onReserve(day, slot);
      };
      cell.appendChild(reserveButton);
    }

    const hasOwnReservation = slot.reservations?.some(
      (reservation) =>
        reservation.userId === opts.authUserId && reservation.approvalStatus !== 'rejected'
    );

    const showActions =
      (opts.canManageSlots && (people > 0 || pendingList.length > 0)) ||
      (hasOwnReservation && !opts.canManageSlots);

    if (showActions) {
      const actions = el('div', 'slot-admin-actions');
      const editButton = el(
        'button',
        'slot-btn-admin slot-btn-edit',
        hasOwnReservation && !opts.canManageSlots ? 'Editar mi turno' : 'Editar'
      );

      editButton.onclick = (event) => {
        event.stopPropagation();
        opts.onEdit?.(day, slot);
      };

      actions.appendChild(editButton);

      if (opts.canManageSlots) {
        const cancelButton = el('button', 'slot-btn-admin slot-btn-cancel', 'Vaciar');
        const reportButton = el('button', 'slot-btn-admin', 'Reporte');

        cancelButton.onclick = (event) => {
          event.stopPropagation();
          opts.onCancel?.(day, slot);
        };

        reportButton.onclick = (event) => {
          event.stopPropagation();
          opts.onReport?.(day, slot);
        };

        actions.appendChild(cancelButton);
        actions.appendChild(reportButton);
      }

      cell.appendChild(actions);
    }

    return cell;
  },

  renderMobileCards(slots, onReserve, opts) {
    const container = document.getElementById('mobile-cards');
    if (!container) return;

    const fragment = document.createDocumentFragment();

    DAYS.forEach((day) => {
      if (!slots[day]?.length) return;

      fragment.appendChild(el('div', 'day-header', FULL_DAY_NAMES[day]));

      slots[day].forEach((slot) => {
        const people = countPeople(slot);
        const names = getPeopleNames(slot, true);
        const pendingList = getPendingReservations(slot);
        const card = el('div', 'slot-card');
        const actions = el('div', 'card-actions');

        card.dataset.status = slot.status;
        card.appendChild(el('div', 'card-time', slot.time));
        card.appendChild(el('div', 'card-capacity', `Confirmados ${people}/${MAX_RESERVATIONS_PER_SLOT}`));

        if (names.length) {
          card.appendChild(el('div', 'card-names', names.join(' · ')));
        }

        if (opts.canManageSlots && pendingList.length) {
          pendingList.forEach((pr) => {
            const row = el('div', 'card-names slot-pending-row');
            row.textContent = `${pr.name} · pendiente`;
            card.appendChild(row);
            const rowBtns = el('div', 'card-actions');
            const ap = el('button', 'btn-admin-sm', 'Aprobar');
            ap.onclick = () => opts.onApproveReservation?.(day, slot, pr.userId);
            const rj = el('button', 'btn-admin-sm btn-danger-sm', 'Rechazar');
            rj.onclick = () => opts.onRejectReservation?.(day, slot, pr.userId);
            rowBtns.appendChild(ap);
            rowBtns.appendChild(rj);
            card.appendChild(rowBtns);
          });
        }

        if (opts.reportsBySlotId?.[slot.id]) {
          card.appendChild(el('div', 'card-names', '📋 Reporte guardado'));
        }

        if (people < MAX_RESERVATIONS_PER_SLOT) {
          const reserveButton = el('button', 'btn-reserve', 'Reservar');
          reserveButton.onclick = () => onReserve(day, slot);
          actions.appendChild(reserveButton);
        }

        const hasOwnReservation = slot.reservations?.some(
          (reservation) =>
            reservation.userId === opts.authUserId && reservation.approvalStatus !== 'rejected'
        );

        const showActions =
          (opts.canManageSlots && (people > 0 || pendingList.length > 0)) ||
          (hasOwnReservation && !opts.canManageSlots);

        if (showActions) {
          const editButton = el(
            'button',
            'btn-admin-sm',
            hasOwnReservation && !opts.canManageSlots ? 'Mi turno' : 'Editar'
          );

          editButton.onclick = () => opts.onEdit?.(day, slot);
          actions.appendChild(editButton);

          if (opts.canManageSlots) {
            const cancelButton = el('button', 'btn-admin-sm btn-danger-sm', 'Vaciar');
            const reportButton = el('button', 'btn-admin-sm', 'Reporte');

            cancelButton.onclick = () => opts.onCancel?.(day, slot);
            reportButton.onclick = () => opts.onReport?.(day, slot);

            actions.appendChild(cancelButton);
            actions.appendChild(reportButton);
          }
        }

        card.appendChild(actions);
        fragment.appendChild(card);
      });
    });

    container.innerHTML = '';
    container.appendChild(fragment);
  }
};
