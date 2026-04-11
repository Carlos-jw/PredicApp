// ─────────────────────────────────────────────
//  toast.js  —  Notificaciones no bloqueantes
//  Reemplaza: alert(), prompt(), confirm()
// ─────────────────────────────────────────────

let container = null;

function getContainer() {
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.setAttribute('aria-live', 'polite');
    container.setAttribute('aria-atomic', 'false');
    document.body.appendChild(container);
  }
  return container;
}

/**
 * Muestra un toast.
 * @param {string} message
 * @param {'success'|'error'|'info'|'warning'} type
 * @param {number} duration  ms antes de desaparecer
 */
export function toast(message, type = 'info', duration = 3500) {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;

  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
  el.innerHTML = `<span class="toast-icon">${icons[type] ?? 'ℹ️'}</span>
                  <span class="toast-msg">${sanitize(message)}</span>`;

  getContainer().appendChild(el);

  // Forzar reflow para que la transición funcione
  el.getBoundingClientRect();
  el.classList.add('toast-visible');

  const remove = () => {
    el.classList.remove('toast-visible');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
  };

  const timer = setTimeout(remove, duration);
  el.addEventListener('click', () => { clearTimeout(timer); remove(); });
}

/**
 * Modal de confirmación que reemplaza confirm().
 * @param {string} message
 * @returns {Promise<boolean>}
 */
export function confirm(message) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-box" role="dialog" aria-modal="true">
        <p class="confirm-msg">${sanitize(message)}</p>
        <div class="confirm-actions">
          <button class="btn-confirm-yes btn-primary">Confirmar</button>
          <button class="btn-confirm-no btn-secondary">Cancelar</button>
        </div>
      </div>`;

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('confirm-visible'));

    const close = (val) => {
      overlay.classList.remove('confirm-visible');
      overlay.addEventListener('transitionend', () => overlay.remove(), { once: true });
      resolve(val);
    };

    overlay.querySelector('.btn-confirm-yes').onclick = () => close(true);
    overlay.querySelector('.btn-confirm-no').onclick  = () => close(false);
    overlay.onclick = e => { if (e.target === overlay) close(false); };
  });
}

/**
 * Input modal que reemplaza prompt().
 * @param {string} label
 * @param {string} [placeholder]
 * @returns {Promise<string|null>}  null si canceló
 */
export function promptInput(label, placeholder = '') {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-box" role="dialog" aria-modal="true">
        <p class="confirm-msg">${sanitize(label)}</p>
        <input type="text" class="prompt-input form-group"
               placeholder="${sanitize(placeholder)}" autocomplete="off">
        <div class="confirm-actions">
          <button class="btn-confirm-yes btn-primary">Aceptar</button>
          <button class="btn-confirm-no btn-secondary">Cancelar</button>
        </div>
      </div>`;

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('confirm-visible'));

    const input = overlay.querySelector('.prompt-input');
    input.focus();

    const close = (val) => {
      overlay.classList.remove('confirm-visible');
      overlay.addEventListener('transitionend', () => overlay.remove(), { once: true });
      resolve(val);
    };

    overlay.querySelector('.btn-confirm-yes').onclick = () => close(input.value.trim() || null);
    overlay.querySelector('.btn-confirm-no').onclick  = () => close(null);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') close(input.value.trim() || null);
      if (e.key === 'Escape') close(null);
    });
  });
}

// Previene XSS en mensajes dinámicos del toast
function sanitize(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
