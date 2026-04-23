const JSPDF_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
let jsPdfLoaded = false;
 
function sanitizeReport(raw = {}) {
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  const HH_MM = /^\d{2}:\d{2}$/;
 
  return {
    slotId: String(raw.slotId ?? '').slice(0, 100),
    day: String(raw.day ?? '').slice(0, 10),
    time: String(raw.time ?? '').slice(0, 20),
    point: String(raw.point ?? '').slice(0, 100),
    participants: Array.isArray(raw.participants)
      ? raw.participants.map((name) => String(name ?? '').trim()).filter(Boolean).slice(0, 10)
      : [],
    date: ISO_DATE.test(String(raw.date ?? ''))
      ? String(raw.date)
      : new Date().toISOString().slice(0, 10),
    startTime: HH_MM.test(String(raw.startTime ?? '')) ? String(raw.startTime) : '',
    fulfilled: Boolean(raw.fulfilled),
    conversation: Boolean(raw.conversation),
    bibleStudy: Boolean(raw.bibleStudy),
    revisits: clampInt(raw.revisits),
    studies: clampInt(raw.studies),
    notes: String(raw.notes ?? '').slice(0, 500)
  };
}
 
function clampInt(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) return 0;
  return Math.max(0, Math.min(9999, parsed));
}
 
async function loadJsPDF() {
  if (jsPdfLoaded || window.jspdf) {
    jsPdfLoaded = true;
    return;
  }
 
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = JSPDF_URL;
    script.onload = () => {
      jsPdfLoaded = true;
      resolve();
    };
    script.onerror = () => reject(new Error('No se pudo cargar jsPDF. Verifica tu conexion.'));
    document.head.appendChild(script);
  });
}
 
function formatDate(value) {
  if (!value) return '-';
  const [year, month, day] = String(value).split('-');
  if (!year || !month || !day) return '-';
  return `${day}/${month}/${year}`;
}
 
function boolLabel(value) {
  return value ? 'Si' : 'No';
}
 
async function exportDoc(doc, filename, action) {
  if (action === 'share' && navigator.canShare) {
    const blob = doc.output('blob');
    const file = new File([blob], filename, { type: 'application/pdf' });
    if (navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'PredicApp' });
      return;
    }
  }
 
  doc.save(filename);
}
 
export async function generatePDF(reports, action = 'download') {
  if (!Array.isArray(reports) || !reports.length) {
    throw new Error('No hay reportes para exportar.');
  }
 
  await loadJsPDF();
 
  const normalizedReports = reports.map((report) => sanitizeReport(report));
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const PAGE_W = 210;
  const MARGIN = 14;
  const COL_W = PAGE_W - MARGIN * 2;
  const LINE_H = 7;
  let y = MARGIN;
 
  const checkPage = (height = LINE_H * 3) => {
    if (y + height > 282) {
      doc.addPage();
      y = MARGIN;
    }
  };
 
  doc.setFillColor(26, 58, 92);
  doc.rect(0, 0, PAGE_W, 18, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.text('PredicApp - Reporte de Turnos', MARGIN, 12);
  doc.setTextColor(35, 35, 35);
  y = 24;
 
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(120, 120, 120);
  doc.text(`Generado: ${new Date().toLocaleString('es')}`, MARGIN, y);
  doc.setTextColor(35, 35, 35);
  y += LINE_H + 2;
 
  const sectionTitle = (text) => {
    checkPage(14);
    doc.setFillColor(240, 244, 248);
    doc.rect(MARGIN, y - 5, COL_W, 9, 'F');
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(26, 58, 92);
    doc.text(text, MARGIN + 2, y);
    doc.setTextColor(35, 35, 35);
    y += LINE_H;
  };
 
  const row = (label, value) => {
    checkPage();
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.text(label, MARGIN, y);
    doc.setFont('helvetica', 'normal');
    const lines = doc.splitTextToSize(String(value ?? '-'), COL_W - 45);
    doc.text(lines, MARGIN + 45, y);
    y += LINE_H * lines.length;
  };
 
  normalizedReports.forEach((report, index) => {
    if (index > 0) {
      checkPage(20);
      y += 4;
    }
 
    sectionTitle(`Turno ${index + 1}: ${report.day} - ${report.time} - ${report.point}`);
    row('Fecha:', formatDate(report.date));
    row('Hora inicio:', report.startTime || '-');
    row('Participantes:', report.participants.join(', ') || '-');
    y += 2;
    row('Cumplido:', boolLabel(report.fulfilled));
    row('Conversaciones:', boolLabel(report.conversation));
    row('Est. biblico:', boolLabel(report.bibleStudy));
    row('Revisitas:', report.revisits);
    row('Estudios:', report.studies);
    if (report.notes) {
      y += 2;
      row('Notas:', report.notes);
    }
 
    doc.setDrawColor(210, 215, 220);
    doc.line(MARGIN, y + 1, MARGIN + COL_W, y + 1);
    y += 6;
  });
 
  const totalPages = doc.getNumberOfPages();
  for (let page = 1; page <= totalPages; page += 1) {
    doc.setPage(page);
    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(160, 160, 160);
    doc.text(`PredicApp - Pagina ${page} de ${totalPages}`, PAGE_W / 2, 292, { align: 'center' });
  }
 
  const filename = `predicapp-reporte-${new Date().toISOString().slice(0, 10)}.pdf`;
  await exportDoc(doc, filename, action);
}
