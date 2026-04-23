import {
  GoogleAuthProvider,
  browserLocalPersistence,
  onAuthStateChanged,
  setPersistence,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';

import { auth } from './db.js';

let persistenceReady = false;

const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

async function ensurePersistence() {
  if (persistenceReady) return;
  await setPersistence(auth, browserLocalPersistence);
  persistenceReady = true;
}

function parseFirebaseError(error) {
  const map = {
    'auth/user-not-found':      'Usuario no encontrado',
    'auth/wrong-password':      'Contraseña incorrecta',
    'auth/invalid-credential':  'Correo o contraseña incorrectos',
    'auth/email-already-in-use':'El correo ya está registrado',
    'auth/popup-blocked':       'El navegador bloqueó el popup',
  };
  return map[error.code] || 'Error de autenticación';
}

export async function signIn(email, password) {
  try {
    await ensurePersistence();
    return await signInWithEmailAndPassword(auth, email, password);
  } catch (error) {
    throw new Error(parseFirebaseError(error));
  }
}

export async function signInWithGoogle() {
  try {
    await ensurePersistence();
    return await signInWithPopup(auth, googleProvider);
  } catch (error) {
    throw new Error(parseFirebaseError(error));
  }
}

export async function logout() {
  return signOut(auth);
}

export function observeSession(callback) {
  return onAuthStateChanged(auth, callback);
}
