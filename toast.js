// ─────────────────────────────────────────────
//  toast.js  —  Notificaciones no bloqueantes
//  Reemplaza: alert(), prompt(), confirm()
//  PredicApp v3.0
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
 * Muestra un toast no bloqueante.
 * @param {string} message
 * @param {'success'|'error'|'info'|'warning'} type
 * @param {number} duration  ms antes de desaparecer (default 3500)
 */
export function toast(message, type = 'info', duration = 3500) {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;

  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
  el.innerHTML =
    '<span class="toast-icon">' + (icons[type] ?? 'ℹ️') + '</span>' +
    '<span class="toast-msg">'  + sanitize(message) + '</span>';

  getContainer().appendChild(el);

  // Forzar reflow para activar la transición CSS
  el.getBoundingClientRect();
  el.classList.add('toast-visible');

  const remove = () => {
    el.classList.remove('toast-visible');
    let removed = false;
    const cleanup = () => {
      if (removed) return;
      removed = true;
      el.remove();
    };
    el.addEventListener('transitionend', cleanup, { once: true });
    // Fallback: evita nodos colgados si no dispara transitionend.
    setTimeout(cleanup, 300);
  };

  const timer = setTimeout(remove, duration);
  // Toque/clic cierra el toast inmediatamente
  el.addEventListener('click', () => { clearTimeout(timer); remove(); });
}

/**
 * Modal de confirmación que reemplaza confirm() nativo.
 * @param {string} message
 * @returns {Promise<boolean>}
 */
export function confirm(message) {
  return new Promise(resolve => {
    const previousFocus = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML =
      '<div class="confirm-box" role="dialog" aria-modal="true" aria-labelledby="confirm-msg-id">' +
        '<p class="confirm-msg" id="confirm-msg-id">' + sanitize(message) + '</p>' +
        '<div class="confirm-actions">' +
          '<button class="btn-confirm-yes btn-primary">Confirmar</button>' +
          '<button class="btn-confirm-no btn-secondary">Cancelar</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('confirm-visible'));

    const close = (val) => {
      overlay.classList.remove('confirm-visible');
      let removed = false;
      const cleanup = () => {
        if (removed) return;
        removed = true;
        overlay.remove();
        previousFocus?.focus();
      };
      overlay.addEventListener('transitionend', cleanup, { once: true });
      // Fallback por si la transición no emite evento.
      setTimeout(cleanup, 300);
      resolve(val);
    };

    overlay.querySelector('.btn-confirm-yes').onclick = () => close(true);
    overlay.querySelector('.btn-confirm-no').onclick  = () => close(false);
    overlay.onclick = e => { if (e.target === overlay) close(false); };
  });
}

/**
 * Input modal que reemplaza prompt() nativo.
 * @param {string} label        - Texto del mensaje/etiqueta
 * @param {string} [placeholder]
 * @returns {Promise<string|null>}  null si el usuario canceló
 */
export function promptInput(label, placeholder = '') {
  return new Promise(resolve => {
    const previousFocus = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML =
      '<div class="confirm-box" role="dialog" aria-modal="true" aria-labelledby="prompt-label-id">' +
        '<p class="confirm-msg" id="prompt-label-id">' + sanitize(label) + '</p>' +
        '<input type="text" class="prompt-input form-group"' +
               ' placeholder="' + sanitize(placeholder) + '" autocomplete="off">' +
        '<div class="confirm-actions">' +
          '<button class="btn-confirm-yes btn-primary">Aceptar</button>' +
          '<button class="btn-confirm-no btn-secondary">Cancelar</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('confirm-visible'));

    const input = overlay.querySelector('.prompt-input');
    // Pequeño delay para que el teclado aparezca en móvil
    setTimeout(() => input.focus(), 80);

    const close = (val) => {
      overlay.classList.remove('confirm-visible');
      let removed = false;
      const cleanup = () => {
        if (removed) return;
        removed = true;
        overlay.remove();
        previousFocus?.focus();
      };
      overlay.addEventListener('transitionend', cleanup, { once: true });
      // Fallback por si la transición no emite evento.
      setTimeout(cleanup, 300);
      resolve(val);
    };

    overlay.querySelector('.btn-confirm-yes').onclick = () => close(input.value.trim() || null);
    overlay.querySelector('.btn-confirm-no').onclick  = () => close(null);
    overlay.onclick = e => { if (e.target === overlay) close(null); };
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  close(input.value.trim() || null);
      if (e.key === 'Escape') close(null);
    });
  });
}

// Previene XSS en mensajes dinámicos
function sanitize(str) {
  const div = document.createElement('div');
  div.textContent = String(str ?? '');
  return div.innerHTML;
}
