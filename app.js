// Variable global para acceso temporal desde HTML inline
window.openReserve = null;

document.addEventListener('DOMContentLoaded', () => {
  initDB();
  
  const state = {
    slots: DB.getObj('slots'),
    points: DB.get('points'),
    participants: DB.get('participants'),
    currentSlot: null
  };

  // Render inicial
  UI.renderBoard(state.slots);
  document.getElementById('count-part').textContent = state.participants.length;
  document.getElementById('count-point').textContent = state.points.length;

  // Navegación
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      if (tab.dataset.view === 'reserve') UI.toggleModal('modal-reserve', true);
      if (tab.dataset.view === 'people') UI.toggleModal('modal-participant', true);
      if (tab.dataset.view === 'admin') UI.toggleModal('modal-admin', true);
    };
  });

  // Cerrar modales
  document.querySelectorAll('.close-btn, .close-modal').forEach(b => {
    b.onclick = () => document.querySelectorAll('.modal').forEach(m => m.classList.remove('active'));
  });

  // Función de reserva
  window.openReserve = (d, sl) => {
    state.currentSlot = { d, sl };
    const sel = document.getElementById('sel-participant');
    sel.innerHTML = '<option value="">Selecciona...</option>';
    state.participants.forEach(p => sel.innerHTML += `<option value="${p.name}">${p.name}</option>`);
    
    const selP = document.getElementById('sel-point');
    selP.innerHTML = '<option value="">Selecciona...</option>';
    state.points.forEach(p => selP.innerHTML += `<option value="${p}">${p}</option>`);
    
    document.getElementById('res-info').value = `${UI.getFullDay(d)} - ${sl.time}`;
    UI.toggleModal('modal-reserve', true);
  };

  // Confirmar Reserva
  document.getElementById('btn-confirm-reserve').onclick = () => {
    const name = document.getElementById('sel-participant').value;
    const point = document.getElementById('sel-point').value;
    if (!name || !point) return alert('Faltan datos');

    const { d, sl } = state.currentSlot;
    sl.reservations.push({ name, point });
    if (sl.reservations.length >= 2) sl.status = 'full';
    else sl.status = 'partial';
    
    DB.setObj('slots', state.slots);
    UI.renderBoard(state.slots);
    UI.toggleModal('modal-reserve', false);
    alert('✅ Turno reservado');
  };

  // Agregar Participante
  document.getElementById('btn-save-part').onclick = () => {
    const name = document.getElementById('inp-part-name').value;
    if (!name) return;
    state.participants.push({ name, phone: '' });
    DB.set('participants', state.participants);
    document.getElementById('count-part').textContent = state.participants.length;
    UI.toggleModal('modal-participant', false);
    document.getElementById('inp-part-name').value = '';
    alert('✅ Participante guardado');
  };

  // Panel Admin
  document.getElementById('btn-admin-login').onclick = () => {
    const pass = prompt('Contraseña de encargado (por defecto: admin):');
    if (pass === 'admin') {
      document.getElementById('tab-admin').style.display = 'block';
      document.getElementById('role-badge').style.display = 'inline';
      // Render listas admin
      const lp = document.getElementById('list-points');
      lp.innerHTML = state.points.map(p => `<li>${p}</li>`).join('');
    }
  };
  
  document.getElementById('btn-add-point').onclick = () => {
    const p = prompt('Nombre del punto:');
    if(p) {
      state.points.push(p);
      DB.set('points', state.points);
      document.getElementById('count-point').textContent = state.points.length;
      alert('✅ Punto agregado');
    }
  };
});