const UI = {
  DAYS: ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'],

  getFullDay: (d) => {
    const m = {Lun:'Lunes',Mar:'Martes',Mié:'Miércoles',Jue:'Jueves',Vie:'Viernes',Sáb:'Sábado',Dom:'Domingo'};
    return m[d];
  },

  renderBoard: (slots) => {
    const tbody = document.getElementById('table-body');
    const cards = document.getElementById('mobile-cards');
    tbody.innerHTML = ''; cards.innerHTML = '';
    let parti = 0, full = 0;
    const times = ['07:00-09:00','09:00-11:00','11:00-13:00','13:00-15:00','15:00-17:00','17:00-19:00'];

    // Desktop: filas por hora, columnas por día
    times.forEach(t => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td><strong>${t}</strong></td>`;

      UI.DAYS.forEach(d => {
        const slot = slots[d]?.find(s => s.time === t);
        const td = document.createElement('td');
        if (!slot) { td.textContent = '—'; tr.appendChild(td); return; }

        const isFull = slot.reservations.length >= 2;
        if (isFull) full++; else if (slot.reservations.length === 1) parti++;
        slot.status = isFull ? 'full' : (slot.reservations.length === 1 ? 'partial' : 'free');

        td.className = `slot-cell ${slot.status}`;
        td.innerHTML = slot.reservations.length > 0
          ? slot.reservations.map(r => r.name.split(' ')[0]).join('<br>')
          : '➕';
        if (slot.status !== 'full') td.onclick = () => window.openReserve(d, slot);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });

    // Móvil: tarjetas agrupadas por día
    UI.DAYS.forEach(d => {
      if (!slots[d]) return;

      const header = document.createElement('div');
      header.className = 'mobile-day-header';
      header.textContent = `📅 ${UI.getFullDay(d)}`;
      cards.appendChild(header);

      slots[d].forEach(slot => {
        const isFull = slot.reservations.length >= 2;
        slot.status = isFull ? 'full' : (slot.reservations.length === 1 ? 'partial' : 'free');

        const card = document.createElement('div');
        card.className = 'slot-card';

        const timeEl = document.createElement('span');
        timeEl.className = 'card-time';
        timeEl.textContent = slot.time;

        const dotEl = document.createElement('span');
        dotEl.className = `dot ${slot.status}`;

        const btn = document.createElement('button');
        btn.className = `btn-reserve${slot.status === 'full' ? ' btn-full' : ''}`;
        btn.textContent = slot.status === 'full' ? 'Completo' : (slot.reservations.length > 0 ? 'Ver' : 'Reservar');
        btn.disabled = slot.status === 'full';
        btn.onclick = () => { if (slot.status !== 'full') window.openReserve(d, slot); };

        card.appendChild(timeEl);
        card.appendChild(dotEl);
        card.appendChild(btn);
        cards.appendChild(card);
      });
    });

    document.getElementById('count-parti').textContent = parti;
    document.getElementById('count-comp').textContent = full;
  },

  toggleModal: (id, show) => {
    document.getElementById(id).classList.toggle('active', show);
  }
};
