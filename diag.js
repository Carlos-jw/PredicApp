/**
 * Diagnóstico mínimo: red (¿blocked?) + lectura users/{uid} + query users (admin).
 * Abre http://localhost:3000/diag.html con npm run dev.
 */
import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import {
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signOut
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  limit,
  query
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';

const logEl = document.getElementById('log');

function log(line, isErr = false) {
  const p = document.createElement('div');
  p.className = isErr ? 'err' : '';
  p.textContent = line;
  logEl.appendChild(p);
}

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
/** Sin caché persistente: evita estados viejos al depurar. */
const db = getFirestore(app);

document.getElementById('btn-google').addEventListener('click', async () => {
  logEl.innerHTML = '';
  log('Proyecto Firestore: ' + firebaseConfig.projectId);
  try {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    log('Abriendo Google…');
    const { user } = await signInWithPopup(auth, provider);
    const uid = user.uid;
    log('Auth OK. UID: ' + uid);

    const ref = doc(db, 'users', uid);
    log('Leyendo users/' + uid + ' …');
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      log(
        'El documento users/' + uid + ' NO existe. La app suele crearlo al entrar; si falla todo, revisa reglas y red.',
        true
      );
      return;
    }
    const d = snap.data();
    log('users/{uid} existe. role=' + JSON.stringify(d.role) + ' (debe ser string "admin" para super)');
    log('adminApproved=' + JSON.stringify(d.adminApproved) + ' status=' + JSON.stringify(d.status));

    log('Query: collection(users) limit 3 (solo admins pasan en reglas actuales)…');
    const q = query(collection(db, 'users'), limit(3));
    const list = await getDocs(q);
    log('OK: leidos ' + list.size + ' documentos de users (si eres admin debería ser > 0).');
  } catch (e) {
    const msg = e?.message || String(e);
    const code = e?.code || '';
    log('ERROR: ' + msg + ' | code=' + code, true);
    if (msg.includes('blocked') || code === 'unavailable') {
      log(
        'Pista: suele ser extensiones, Brave Shields o antivirus bloqueando firestore.googleapis.com.',
        true
      );
    }
    if (code === 'permission-denied') {
      log(
        'Pista: reglas Firestore o usuario sin rol admin para listar users. Comprueba reglas desplegadas y documento users/{uid}.',
        true
      );
    }
  }
});

document.getElementById('btn-out').addEventListener('click', async () => {
  await signOut(auth);
  logEl.innerHTML = '';
  log('Sesión cerrada.');
});

onAuthStateChanged(auth, (u) => {
  document.getElementById('who').textContent = u ? 'Conectado: ' + u.email : 'Sin sesión';
});
