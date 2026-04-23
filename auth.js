import { getApps, initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import {
  GoogleAuthProvider,
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  deleteUser,
  fetchSignInMethodsForEmail,
  getAuth,
  onAuthStateChanged,
  setPersistence,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  sendPasswordResetEmail
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';

import { firebaseConfig } from './firebase-config.js';
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

const PROVISION_APP_NAME = 'PredicappCaptainProvision';

function getProvisionAuth() {
  const app = getApps().find((a) => a.name === PROVISION_APP_NAME) ?? initializeApp(
    firebaseConfig,
    PROVISION_APP_NAME
  );
  return getAuth(app);
}

function randomOneTimePassword() {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return `Aa1${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Métodos de inicio de sesión asociados al correo (proyecto principal; mismo `auth` que el super).
 */
export function getAuthSignInMethodsForEmail(email) {
  return fetchSignInMethodsForEmail(auth, String(email ?? '').trim());
}

/**
 * Crea el usuario en Firebase Auth sin cerrar la sesion del super (app secundaria).
 * Luego el super guarda `users/{uid}` y hace `endOk()`; si falla Firestore, `rollback()`.
 */
export async function createCaptainAccountByEmail(email) {
  const clean = String(email ?? '').trim();
  if (!clean) {
    throw new Error('El correo del capitán es obligatorio.');
  }
  const provAuth = getProvisionAuth();
  const cred = await createUserWithEmailAndPassword(provAuth, clean, randomOneTimePassword());
  return {
    uid: cred.user.uid,
    async endOk() {
      await signOut(provAuth);
    },
    async rollback() {
      try {
        await deleteUser(cred.user);
      } catch {
        /* ya borrado o expiró el token de la app de provision */
      }
      try {
        await signOut(provAuth);
      } catch {
        /* */
      }
    }
  };
}

/** Enviar enlace "restablecer contrasena" al correo (desde el mismo proyecto, sin afectar la sesion del super). */
export function sendCaptainFirstPasswordEmail(email) {
  const clean = String(email ?? '').trim();
  if (!clean) return Promise.resolve();
  return sendPasswordResetEmail(auth, clean);
}
