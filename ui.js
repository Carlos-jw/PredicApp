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

    times.forEach(t => {
      // Desktop Row
      const tr = document.createElement('tr');
      tr.innerHTML = `<td><strong>${t}</strong></td>`;
      
      // Mobile Header (solo si es la primera hora para no repetir)
      // Lógica simplificada para tarjetas
      tr.appendChild(document.createElement('td')); // Placeholder logic
      
      UI.DAYS.forEach(d => {
        const slot = slots[d]?.find(s => s.time === t);
        if (!slot) return;
        const isFull = slot.reservations.length >= 2;
        if (isFull) full++; else if (slot.reservations.length === 1) parti++;
        slot.status = isFull ? 'full' : (slot.reservations.length === 1 ? 'partial' : 'free');

        // Desktop Cell
        const td = document.createElement('td');
        td.className = `slot-cell ${slot.status}`;
        td.innerHTML = slot.reservations.length > 0 ? slot.reservations.map(r => r.name.split(' ')[0]).join('<br>') : '➕';
        td.onclick = () => window.openReserve(d, slot);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });

    // Render Mobile Cards (Agrupado por día)
    UI.DAYS.forEach(d => {
      if(!slots[d]) return;
      const header = document.createElement('div');
      header.className = 'mobile-day-header';
      header.textContent = UI.getFullDay(d);
      // cards.appendChild(header); // Necesita estilo en CSS si se activa
      
      slots[d].forEach(slot => {
        const card = document.createElement('div');
        card.className = 'slot-card';
        card.innerHTML = `<span>${slot.time}</span> <span class="dot ${slot.status}"></span> <button class="btn-reserve">${slot.reservations.length>0?'Ver':'Reservar'}</button>`;
        card.onclick = () => window.openReserve(d, slot);
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