const DB = {
  get: (key) => JSON.parse(localStorage.getItem(`predicapp_${key}`) || '[]'),
  set: (key, val) => localStorage.setItem(`predicapp_${key}`, JSON.stringify(val)),
  getObj: (key) => JSON.parse(localStorage.getItem(`predicapp_${key}`) || '{}'),
  setObj: (key, val) => localStorage.setItem(`predicapp_${key}`, JSON.stringify(val))
};

// Inicialización de datos por defecto
function initDB() {
  if (!localStorage.getItem('predicapp_points')) {
    DB.set('points', ['Parroquia Central', 'Plaza Norte', 'Barrio Sur']);
  }
  if (!localStorage.getItem('predicapp_slots')) {
    const DAYS = ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'];
    const TIMES = ['07:00-09:00','09:00-11:00','11:00-13:00','13:00-15:00','15:00-17:00','17:00-19:00'];
    const slots = {};
    DAYS.forEach(d => {
      slots[d] = TIMES.map(t => ({ id: `${d}-${t}`, time: t, status: 'free', reservations: [] }));
    });
    DB.setObj('slots', slots);
  }
}