import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getDocsFromServer,
  initializeFirestore,
  onSnapshot,
  orderBy,
  persistentLocalCache,
  persistentMultipleTabManager,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';
 
import {
  COLLECTIONS,
  DAYS,
  DEFAULT_POINTS,
  POINT_DATA_DOCS,
  RESERVATION_APPROVAL,
  ROLES,
  buildDefaultSlots,
  normalizePointId
} from './config.js?v=4.2';
import { USER_STATUS } from './user-status.js?v=1';
import {
  computeStatus,
  getUserReservationsAcrossPoints as collectUserReservationsAcrossPoints,
  removeReservationByUser,
  validateReservation,
  upsertReservationForUser
} from './reservations.js';
 
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager()
  })
});
 
/** getDoc puede fallar con permission-denied si Firestore aun no enlaza el token tras el login. */
async function getDocWithAuthWarmup(docRef, user) {
  if (typeof auth.authStateReady === 'function') {
    await auth.authStateReady();
  }
  const delaysMs = [0, 80, 200, 450];
  let lastError = null;
  let forceToken = true;
  for (let i = 0; i < delaysMs.length; i += 1) {
    if (delaysMs[i] > 0) {
      await new Promise((resolve) => setTimeout(resolve, delaysMs[i]));
    }
    await user.getIdToken(forceToken);
    forceToken = false;
    try {
      return await getDoc(docRef);
    } catch (err) {
      lastError = err;
      if (err?.code !== 'permission-denied' || i === delaysMs.length - 1) {
        throw err;
      }
      forceToken = true;
    }
  }
  throw lastError ?? new Error('getDoc fallo');
}

const localCache = {
  currentUserProfile: null,
  points: [],
  users: [],
  participants: [],
  reports: [],
  slots: {}
};
 
let selectedPointId = '';
let pointDataUnsubs = [];
let participantsDirectoryUnsubs = [];
let isOnline = typeof navigator === 'undefined' ? true : navigator.onLine;
const connectionListeners = [];
 
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    isOnline = true;
    notifyConnection();
  });
 
  window.addEventListener('offline', () => {
    isOnline = false;
    notifyConnection();
  });
}
 
function notifyConnection() {
  connectionListeners.forEach((listener) => listener(isOnline));
}
 
export function onConnectionChange(listener) {
  if (typeof listener !== 'function') return () => {};
  connectionListeners.push(listener);
  listener(isOnline);
  return () => {
    const index = connectionListeners.indexOf(listener);
    if (index !== -1) connectionListeners.splice(index, 1);
  };
}
 
function pointDocRef(pointId) {
  return doc(db, COLLECTIONS.POINTS, pointId);
}
 
function pointDataRef(pointId, dataDocId) {
  return doc(db, COLLECTIONS.POINTS, pointId, 'data', dataDocId);
}
 
function userDocRef(userId) {
  return doc(db, COLLECTIONS.USERS, userId);
}

/** Un solo ensureUserProfile por uid (p. ej. sesion + otro caller) evita setDoc duplicado → update denegado por reglas. */
const ensureUserProfileInFlight = new Map();

function replaceListenerBucket(bucket, nextListeners) {
  bucket.forEach((unsubscribe) => unsubscribe());
  return nextListeners;
}
 
function emitPointPayload(callback) {
  callback?.({
    points: localCache.points,
    participants: localCache.participants,
    slots: localCache.slots,
    reports: localCache.reports
  });
}
 
async function resolvePointSubadmin(pointId) {
  const point = localCache.points.find((item) => item.id === pointId);
  if (point?.subadminId) {
    return {
      id: point.subadminId,
      displayName: point.subadminName ?? ''
    };
  }

  // Fallback: releer el documento del punto desde Firestore.
  // localCache.users solo está disponible para admins, por lo que no
  // puede usarse como fallback confiable para usuarios regulares.
  try {
    const snap = await getDoc(pointDocRef(pointId));
    if (snap.exists() && snap.data().subadminId) {
      return {
        id: snap.data().subadminId,
        displayName: snap.data().subadminName ?? ''
      };
    }
  } catch (_) {
    // Si la lectura falla, continuar con null y dejar que el caller maneje el error.
  }

  return null;
}
 
function normalizeUserId(userId) {
  return String(userId ?? '').trim();
}
 
function normalizeParticipantName(name) {
  return String(name ?? '').trim().toLowerCase();
}

function canManageAnyReservation(actor, pointId) {
  return actor?.role === ROLES.ADMIN || (
    actor?.role === ROLES.SUBADMIN &&
    Array.isArray(actor.assignedPointIds) &&
    actor.assignedPointIds.includes(pointId)
  );
}
 
function sanitizeReservation(pointId, reservation = {}) {
  const raw = reservation.approvalStatus;
  let approvalStatus = RESERVATION_APPROVAL.APPROVED;
  if (raw === RESERVATION_APPROVAL.PENDING) approvalStatus = RESERVATION_APPROVAL.PENDING;
  else if (raw === RESERVATION_APPROVAL.REJECTED) approvalStatus = RESERVATION_APPROVAL.REJECTED;

  return {
    userId: normalizeUserId(reservation.userId),
    pointId: reservation.pointId || pointId,
    name: String(reservation.name ?? '').trim(),
    point: String(reservation.point ?? '').trim(),
    companions: Array.isArray(reservation.companions)
      ? reservation.companions.filter((item) => item && String(item).trim() !== '')
      : [],
    assignedSubadminId: normalizeUserId(reservation.assignedSubadminId),
    assignedSubadminName: String(reservation.assignedSubadminName ?? '').trim(),
    approvalStatus
  };
}
 
function sanitizeSlots(pointId, slots = {}) {
  const next = {};
  Object.entries(slots).forEach(([day, daySlots]) => {
    next[day] = Array.isArray(daySlots)
      ? daySlots.map((slot) => ({
        ...slot,
        reservations: Array.isArray(slot.reservations)
          ? slot.reservations.map((reservation) => sanitizeReservation(pointId, reservation))
            .filter((reservation) => reservation.userId && reservation.name)
          : []
      }))
      : [];
  });
  return next;
}

function mergeUserAssignedPointFields(payload = {}) {
  const nextPayload = { ...payload };
  const assignedPointId = String(nextPayload.assignedPointId ?? '').trim();
  const assignedPointIds = Array.isArray(nextPayload.assignedPointIds)
    ? nextPayload.assignedPointIds.map((pointId) => String(pointId ?? '').trim()).filter(Boolean)
    : null;

  if (assignedPointId) {
    nextPayload.assignedPointIds = [assignedPointId];
  } else if (assignedPointIds) {
    nextPayload.assignedPointIds = assignedPointIds;
    nextPayload.assignedPointId = assignedPointIds[0] ?? '';
  }

  return nextPayload;
}

function removeUserReservationsFromSlots(slots = {}, userId) {
  const cleanUserId = normalizeUserId(userId);
  if (!cleanUserId) return { slots, removedCount: 0, changed: false };

  const nextSlots = {};
  let removedCount = 0;
  let changed = false;

  Object.entries(slots).forEach(([day, daySlots]) => {
    if (!Array.isArray(daySlots)) {
      nextSlots[day] = [];
      return;
    }

    nextSlots[day] = daySlots.map((slot) => {
      const reservations = Array.isArray(slot?.reservations) ? slot.reservations : [];
      const filteredReservations = reservations.filter((reservation) => {
        const shouldKeep = normalizeUserId(reservation?.userId) !== cleanUserId;
        if (!shouldKeep) removedCount += 1;
        return shouldKeep;
      });

      if (filteredReservations.length === reservations.length) {
        return slot;
      }

      changed = true;
      return {
        ...slot,
        reservations: filteredReservations,
        status: computeStatus({ ...slot, reservations: filteredReservations })
      };
    });
  });

  return { slots: nextSlots, removedCount, changed };
}

async function loadAllPoints() {
  if (localCache.points.length) return localCache.points;

  const snapshot = await getDocs(collection(db, COLLECTIONS.POINTS));
  return snapshot.docs.map((pointDoc) => ({
    id: pointDoc.id,
    ...pointDoc.data()
  }));
}

async function loadPointSources(pointRows) {
  const points = Array.isArray(pointRows) ? pointRows : [];
  const pointSources = await Promise.all(points.map(async (point) => {
    const snapshot = await getDoc(pointDataRef(point.id, POINT_DATA_DOCS.SLOTS));
    return {
      pointId: point.id,
      pointName: point.name ?? '',
      subadminId: point.subadminId ?? '',
      subadminName: point.subadminName ?? '',
      slots: snapshot.exists()
        ? sanitizeSlots(point.id, snapshot.data().items ?? {})
        : {}
    };
  }));

  return pointSources;
}
 
export const DB = {
  get(key, fallback = null) {
    return localCache[key] ?? fallback;
  },
 
  isOnline() {
    return isOnline;
  },
 
  getSelectedPointId() {
    return selectedPointId;
  },
 
  setSelectedPoint(pointId) {
    selectedPointId = pointId ?? '';
  },
 
  async listPointDocumentsPublic() {
    const colRef = collection(db, COLLECTIONS.POINTS);
    let snapshot;
    try {
      snapshot = await getDocsFromServer(colRef);
    } catch (err) {
      console.warn('[PredicApp] getDocsFromServer(points) fallo, usando cache/red local.', err);
      snapshot = await getDocs(colRef);
    }
    const rows = snapshot.docs.map((pointDoc) => ({
      id: pointDoc.id,
      ...pointDoc.data()
    }));
    rows.sort((a, b) => {
      const na = String(a?.name ?? a?.id ?? '').trim();
      const nb = String(b?.name ?? b?.id ?? '').trim();
      return na.localeCompare(nb, undefined, { sensitivity: 'base' });
    });
    return rows;
  },

  async bootstrapDefaults(adminUid) {
    const snapshot = await getDocs(collection(db, COLLECTIONS.POINTS));
    if (!snapshot.empty) return;
 
    for (const pointName of DEFAULT_POINTS) {
      const pointId = normalizePointId(pointName);
      await this.createPoint({
        pointId,
        name: pointName,
        createdBy: adminUid
      });
    }
  },

  subscribeUserProfile(userId, callback) {
    let hadDocument = false;
    return onSnapshot(
      userDocRef(userId),
      (snapshot) => {
        if (!snapshot.exists()) {
          if (hadDocument) {
            localCache.currentUserProfile = null;
            callback?.(null);
          }
          return;
        }
        hadDocument = true;
        localCache.currentUserProfile = { id: snapshot.id, ...snapshot.data() };
        callback?.(localCache.currentUserProfile);
      },
      (error) => {
        console.warn('user profile subscription', error);
        localCache.currentUserProfile = null;
        callback?.(null);
      }
    );
  },
 
  subscribePoints(callback) {
    const pointsQuery = query(collection(db, COLLECTIONS.POINTS), orderBy('name'));
    return onSnapshot(
      pointsQuery,
      (snapshot) => {
        localCache.points = snapshot.docs.map((pointDoc) => ({
          id: pointDoc.id,
          ...pointDoc.data()
        }));
        emitPointPayload(callback);
      },
      (error) => {
        console.warn('points subscription', error);
        localCache.points = [];
        emitPointPayload(callback);
      }
    );
  },
 
  subscribeUsers(callback, onListenError) {
    return onSnapshot(
      collection(db, COLLECTIONS.USERS),
      (snapshot) => {
        localCache.users = snapshot.docs.map((userDoc) => ({
          id: userDoc.id,
          ...userDoc.data()
        }));
        callback?.(localCache.users);
      },
      (error) => {
        console.warn('users subscription', error);
        localCache.users = [];
        callback?.(localCache.users);
        onListenError?.(error);
      }
    );
  },
 
  subscribePointData(pointId, callback, onListenError) {
    selectedPointId = pointId ?? '';
    pointDataUnsubs = replaceListenerBucket(pointDataUnsubs, []);

    if (!pointId) {
      localCache.participants = [];
      localCache.reports = [];
      localCache.slots = {};
      emitPointPayload(callback);
      return () => {};
    }

    const onSnapErr = (label) => (error) => {
      console.warn(`pointData ${label}`, error);
      if (label === 'participants') localCache.participants = [];
      if (label === 'slots') localCache.slots = {};
      if (label === 'reports') localCache.reports = [];
      emitPointPayload(callback);
      onListenError?.(error, label);
    };

    pointDataUnsubs = [
      onSnapshot(
        pointDataRef(pointId, POINT_DATA_DOCS.PARTICIPANTS),
        (snapshot) => {
          localCache.participants = snapshot.exists() ? snapshot.data().items ?? [] : [];
          emitPointPayload(callback);
        },
        onSnapErr('participants')
      ),
      onSnapshot(
        pointDataRef(pointId, POINT_DATA_DOCS.SLOTS),
        (snapshot) => {
          localCache.slots = snapshot.exists()
            ? sanitizeSlots(pointId, snapshot.data().items ?? {})
            : {};
          emitPointPayload(callback);
        },
        onSnapErr('slots')
      ),
      onSnapshot(
        pointDataRef(pointId, POINT_DATA_DOCS.REPORTS),
        (snapshot) => {
          localCache.reports = snapshot.exists() ? snapshot.data().items ?? [] : [];
          emitPointPayload(callback);
        },
        onSnapErr('reports')
      )
    ];
 
    return () => {
      pointDataUnsubs = replaceListenerBucket(pointDataUnsubs, []);
    };
  },
 
  subscribeParticipantsDirectory(pointIds, callback) {
    participantsDirectoryUnsubs = replaceListenerBucket(participantsDirectoryUnsubs, []);
 
    const cleanPointIds = Array.from(new Set(
      (Array.isArray(pointIds) ? pointIds : [])
        .map((pointId) => String(pointId ?? '').trim())
        .filter(Boolean)
    ));
 
    if (!cleanPointIds.length) {
      callback?.([]);
      return () => {};
    }
 
    const participantsByPoint = new Map();
 
    const emit = () => {
      const rows = cleanPointIds.flatMap((pointId) => {
        const pointName = localCache.points.find((point) => point.id === pointId)?.name ?? pointId;
        const participants = participantsByPoint.get(pointId) ?? [];
 
        return participants.map((participant, index) => ({
          id: `${pointId}::${index}::${String(participant.name ?? '').trim().toLowerCase()}`,
          name: String(participant.name ?? '').trim(),
          phone: String(participant.phone ?? '').trim(),
          pointId,
          pointName
        }));
      }).filter((participant) => participant.name);
 
      rows.sort((left, right) => (
        left.name.localeCompare(right.name, 'es', { sensitivity: 'base' }) ||
        left.pointName.localeCompare(right.pointName, 'es', { sensitivity: 'base' })
      ));
 
      callback?.(rows);
    };
 
    participantsDirectoryUnsubs = cleanPointIds.map((pointId) => onSnapshot(
      pointDataRef(pointId, POINT_DATA_DOCS.PARTICIPANTS),
      (snapshot) => {
        participantsByPoint.set(pointId, snapshot.exists() ? (snapshot.data().items ?? []) : []);
        emit();
      },
      (error) => {
        console.warn('participantsDirectory', pointId, error);
        participantsByPoint.set(pointId, []);
        emit();
      }
    ));
 
    return () => {
      participantsDirectoryUnsubs = replaceListenerBucket(participantsDirectoryUnsubs, []);
    };
  },
 
  async ensureUserProfile(user, profilePatch = {}) {
    if (!user?.uid) return;
    const uid = user.uid;
    let inflight = ensureUserProfileInFlight.get(uid);
    if (inflight) return inflight;

    inflight = (async () => {
      try {
        const ref = userDocRef(uid);
        const snapshot = await getDocWithAuthWarmup(ref, user);
        if (snapshot.exists()) return;

        await setDoc(ref, {
          email: user.email ?? '',
          displayName: profilePatch.displayName ?? user.displayName ?? '',
          role: ROLES.USER,
          status: USER_STATUS.PENDIENTE,
          adminApproved: false,
          assignedPointId: '',
          assignedPointName: '',
          assignedPointIds: [],
          assignedSubadminId: '',
          assignedSubadminName: '',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        });
      } finally {
        ensureUserProfileInFlight.delete(uid);
      }
    })();

    ensureUserProfileInFlight.set(uid, inflight);
    return inflight;
  },

  /**
   * Capitán o super de servicio: aprueba cuenta de publicador pendiente.
   */
  async aprobarUsuario(userId) {
    const id = normalizeUserId(userId);
    if (!id) throw new Error('Usuario invalido.');
    await updateDoc(userDocRef(id), {
      status: USER_STATUS.APROBADO,
      updatedAt: serverTimestamp()
    });
    return { ok: true };
  },

  /**
   * Suscripción a publicadores pendientes en alguno de los puntos indicados (capitanes).
   * Requiere índice compuesto en `users`: status + assignedPointIds (array-contains-any).
   */
  subscribePendingUsersByPoints(pointIds, callback, onListenError) {
    const clean = [...new Set((pointIds ?? []).map((x) => String(x ?? '').trim()).filter(Boolean))];
    if (!clean.length) {
      callback?.([]);
      return () => {};
    }

    const buckets = [];
    for (let i = 0; i < clean.length; i += 10) {
      buckets.push(clean.slice(i, i + 10));
    }

    const bucketMaps = buckets.map(() => new Map());

    const emit = () => {
      const merged = new Map();
      bucketMaps.forEach((m) => {
        m.forEach((v, k) => merged.set(k, v));
      });
      callback?.(Array.from(merged.values()));
    };

    const unsubs = buckets.map((bucket, bi) => onSnapshot(
      query(
        collection(db, COLLECTIONS.USERS),
        where('status', '==', USER_STATUS.PENDIENTE),
        where('assignedPointIds', 'array-contains-any', bucket)
      ),
      (snapshot) => {
        bucketMaps[bi].clear();
        snapshot.docs.forEach((d) => {
          bucketMaps[bi].set(d.id, { id: d.id, ...d.data() });
        });
        emit();
      },
      (error) => {
        console.warn('subscribePendingUsersByPoints', error);
        bucketMaps[bi].clear();
        emit();
        onListenError?.(error);
      }
    ));

    return () => {
      unsubs.forEach((u) => u());
    };
  },

  async saveUserProfile(userId, payload) {
    const normalizedUserId = normalizeUserId(userId);
    if (!normalizedUserId) throw new Error('userId es obligatorio');

    const ref = userDocRef(normalizedUserId);
    await runTransaction(db, async (transaction) => {
      const current = await transaction.get(ref);
      transaction.set(ref, mergeUserAssignedPointFields({
        ...(current.exists() ? current.data() : {}),
        ...payload,
        updatedAt: serverTimestamp()
      }));
    });
  },
 
  async assignSubadminToPoint(pointId, subadmin) {
    if (!pointId || !subadmin?.id) return;
    await setDoc(pointDocRef(pointId), {
      subadminId: subadmin.id,
      subadminName: subadmin.displayName || subadmin.email || subadmin.id,
      updatedAt: serverTimestamp()
    }, { merge: true });
  },
 
  async createPoint({ pointId, name, createdBy }) {
    const cleanPointId = pointId || normalizePointId(name);
    if (!cleanPointId) throw new Error('pointId invalido');
    const cleanName = String(name ?? '').trim();
    if (!cleanName) throw new Error('name es obligatorio');

    if (!auth.currentUser) {
      throw new Error('No hay sesion iniciada.');
    }
    await auth.currentUser.getIdToken(true);

    const currentPointSnapshot = await getDoc(pointDocRef(cleanPointId));
    if (currentPointSnapshot.exists()) {
      throw new Error('Ese punto ya existe.');
    }

    const pointPayload = {
      name: cleanName,
      active: true,
      createdBy,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    };

    const batch = writeBatch(db);
    batch.set(pointDocRef(cleanPointId), pointPayload, { merge: true });
    batch.set(pointDataRef(cleanPointId, POINT_DATA_DOCS.PARTICIPANTS), {
      items: [],
      updatedAt: serverTimestamp()
    });
    batch.set(pointDataRef(cleanPointId, POINT_DATA_DOCS.SLOTS), {
      items: buildDefaultSlots(cleanPointId, cleanName),
      updatedAt: serverTimestamp()
    });
    batch.set(pointDataRef(cleanPointId, POINT_DATA_DOCS.REPORTS), {
      items: [],
      updatedAt: serverTimestamp()
    });

    await batch.commit();
    return cleanPointId;
  },
 
  async deletePoint(pointId) {
    const batch = writeBatch(db);
    batch.delete(pointDocRef(pointId));
    batch.delete(pointDataRef(pointId, POINT_DATA_DOCS.PARTICIPANTS));
    batch.delete(pointDataRef(pointId, POINT_DATA_DOCS.SLOTS));
    batch.delete(pointDataRef(pointId, POINT_DATA_DOCS.REPORTS));
    await batch.commit();
  },
 
  async setParticipants(pointId, participants) {
    if (!pointId) return { ok: false, error: 'Punto invalido.' };
 
    await setDoc(pointDataRef(pointId, POINT_DATA_DOCS.PARTICIPANTS), {
      items: participants,
      updatedAt: serverTimestamp()
    }, { merge: true });
 
    return { ok: true, offline: !isOnline };
  },

  async addParticipant(pointId, participant = {}) {
    const cleanPointId = String(pointId ?? '').trim();
    if (!cleanPointId) return { ok: false, error: 'Punto invalido.' };

    const cleanName = String(participant?.name ?? '').trim().slice(0, 80);
    const cleanPhone = String(participant?.phone ?? '').trim().slice(0, 30);
    if (!cleanName) return { ok: false, error: 'El nombre es obligatorio.' };

    try {
      return await runTransaction(db, async (transaction) => {
        const ref = pointDataRef(cleanPointId, POINT_DATA_DOCS.PARTICIPANTS);
        const snapshot = await transaction.get(ref);
        const currentItems = snapshot.exists() && Array.isArray(snapshot.data()?.items)
          ? [...snapshot.data().items]
          : [];

        const exists = currentItems.some((row) => (
          normalizeParticipantName(row?.name) === normalizeParticipantName(cleanName)
        ));
        if (exists) {
          return { ok: false, error: 'Ese participante ya existe en este punto.' };
        }

        transaction.set(ref, {
          items: [
            ...currentItems,
            {
              name: cleanName,
              phone: cleanPhone,
              pointId: cleanPointId
            }
          ],
          updatedAt: serverTimestamp()
        }, { merge: true });

        return { ok: true, offline: !isOnline };
      });
    } catch (error) {
      console.error(error);
      return { ok: false, error: 'No se pudo agregar el participante.' };
    }
  },

  async enrollParticipantPublic({ pointId, name, phone = '', preferredDay = '', preferredTime = '' } = {}) {
    const cleanPointId = String(pointId ?? '').trim();
    const cleanName = String(name ?? '').trim().slice(0, 80);
    const cleanPhone = String(phone ?? '').trim().slice(0, 30);
    const cleanPreferredDay = String(preferredDay ?? '').trim().slice(0, 20);
    const cleanPreferredTime = String(preferredTime ?? '').trim().slice(0, 20);

    if (!cleanPointId) throw new Error('Punto invalido.');
    if (!cleanName) throw new Error('El nombre es obligatorio.');
    if (!cleanPreferredDay) throw new Error('Selecciona un dia preferido.');
    if (!cleanPreferredTime) throw new Error('Selecciona una hora preferida.');

    const participantsRef = pointDataRef(cleanPointId, POINT_DATA_DOCS.PARTICIPANTS);
    const outcome = await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(participantsRef);
      const currentItems = snapshot.exists() && Array.isArray(snapshot.data()?.items)
        ? [...snapshot.data().items]
        : [];

      const exists = currentItems.some((participant) => (
        normalizeParticipantName(participant?.name) === normalizeParticipantName(cleanName)
      ));

      if (exists) {
        return 'exists';
      }

      const nextItems = [
        ...currentItems,
        {
          name: cleanName,
          phone: cleanPhone,
          preferredDay: cleanPreferredDay,
          preferredTime: cleanPreferredTime,
          pointId: cleanPointId,
          createdAt: Date.now()
        }
      ];

      transaction.set(participantsRef, {
        items: nextItems,
        updatedAt: serverTimestamp()
      }, { merge: true });

      return 'added';
    });

    return {
      ok: true,
      alreadyExists: outcome === 'exists',
      offline: !isOnline
    };
  },
 
  async setSlots(pointId, slots) {
    if (!pointId) return { ok: false, error: 'Punto invalido.' };
 
    await setDoc(pointDataRef(pointId, POINT_DATA_DOCS.SLOTS), {
      items: slots,
      updatedAt: serverTimestamp()
    }, { merge: true });
 
    return { ok: true, offline: !isOnline };
  },

  /**
   * Crea o completa dias/horarios faltantes con la grilla por defecto (puntos legacy sin doc `slots`
   * o con `items` vacio o incompleto). Idempotente; no borra reservas existentes.
   */
  async ensureDefaultSlotsIfMissing(pointId, pointName = '') {
    const cleanId = String(pointId ?? '').trim();
    if (!cleanId) return { ok: false, error: 'Punto invalido.' };
    const cleanName = String(pointName ?? '').trim() || cleanId;

    try {
      const outcome = await runTransaction(db, async (transaction) => {
        const ref = pointDataRef(cleanId, POINT_DATA_DOCS.SLOTS);
        const snapshot = await transaction.get(ref);
        const rawItems = snapshot.exists() ? (snapshot.data().items ?? {}) : {};
        const defaults = buildDefaultSlots(cleanId, cleanName);
        let changed = false;
        const next = { ...rawItems };

        for (const day of DAYS) {
          if (!Array.isArray(next[day]) || next[day].length === 0) {
            next[day] = defaults[day];
            changed = true;
          }
        }

        if (!changed) {
          return { seeded: false };
        }

        transaction.set(ref, {
          items: sanitizeSlots(cleanId, next),
          updatedAt: serverTimestamp()
        }, { merge: true });

        return { seeded: true };
      });

      return { ok: true, offline: !isOnline, ...outcome };
    } catch (err) {
      console.warn('ensureDefaultSlotsIfMissing', cleanId, err);
      return { ok: false, error: err?.message ?? String(err) };
    }
  },
 
  async upsertReservation({ pointId, day, time, reservation, actor }) {
    if (!pointId || !day || !time) return { ok: false, error: 'Turno invalido.' };
    const actorUserId = normalizeUserId(actor?.uid);
    const reservationUserId = normalizeUserId(reservation?.userId);
 
    if (!reservationUserId || !reservation?.name) {
      return { ok: false, error: 'Datos de reserva incompletos.' };
    }
    if (!actorUserId) return { ok: false, error: 'Usuario autenticado invalido.' };
 
    const assignedSubadmin = await resolvePointSubadmin(pointId);
    if (!assignedSubadmin) {
      return { ok: false, error: 'No hay capitán asignado para este punto.' };
    }
 
    try {
      const result = await runTransaction(db, async (transaction) => {
        const ref = pointDataRef(pointId, POINT_DATA_DOCS.SLOTS);
        const slotsSnapshot = await transaction.get(ref);
        const slots = slotsSnapshot.exists()
          ? sanitizeSlots(pointId, slotsSnapshot.data().items ?? {})
          : {};
        const daySlots = Array.isArray(slots[day]) ? [...slots[day]] : [];
        const slotIndex = daySlots.findIndex((slot) => slot.time === time);
 
        if (slotIndex === -1) {
          return { ok: false, error: 'No se encontro el turno solicitado.' };
        }
 
        const slot = structuredClone(daySlots[slotIndex]);
        const canManageAny = canManageAnyReservation(actor, pointId);
 
        if (!canManageAny && actorUserId !== reservationUserId) {
          return { ok: false, error: 'No puedes crear o editar turnos de otro usuario.' };
        }
 
        const approvalStatus = canManageAny ? RESERVATION_APPROVAL.APPROVED : RESERVATION_APPROVAL.PENDING;

        const upsertResult = upsertReservationForUser(slot, {
          ...reservation,
          userId: canManageAny ? reservationUserId : actorUserId,
          pointId,
          assignedSubadminId: assignedSubadmin.id,
          assignedSubadminName: assignedSubadmin.displayName || assignedSubadmin.email || assignedSubadmin.id,
          approvalStatus
        });
        if (!upsertResult.ok) return upsertResult;
 
        daySlots[slotIndex] = slot;
        slots[day] = daySlots;
 
        transaction.set(ref, {
          items: slots,
          updatedAt: serverTimestamp()
        }, { merge: true });
 
        return { ok: true, mode: upsertResult.mode };
      });
 
      return { ...result, offline: !isOnline };
    } catch (error) {
      console.error(error);
      return { ok: false, error: 'No se pudo guardar la reserva.' };
    }
  },

  /**
   * Capitán o super: confirma una solicitud en el tablero, o la descarta (rechazo = quitar fila).
   */
  async setReservationRequestDecision({
    pointId,
    day,
    time,
    targetUserId,
    approve,
    actor
  }) {
    const cleanPointId = String(pointId ?? '').trim();
    const cleanDay = String(day ?? '').trim();
    const cleanTime = String(time ?? '').trim();
    const cleanTarget = normalizeUserId(targetUserId);
    const actorUserId = normalizeUserId(actor?.uid);

    if (!cleanPointId || !cleanDay || !cleanTime || !cleanTarget || !actorUserId) {
      return { ok: false, error: 'Solicitud invalida.' };
    }

    if (!canManageAnyReservation(actor, cleanPointId)) {
      return { ok: false, error: 'No tienes permiso para gestionar este punto.' };
    }

    try {
      const result = await runTransaction(db, async (transaction) => {
        const ref = pointDataRef(cleanPointId, POINT_DATA_DOCS.SLOTS);
        const slotsSnapshot = await transaction.get(ref);
        const slots = slotsSnapshot.exists()
          ? sanitizeSlots(cleanPointId, slotsSnapshot.data().items ?? {})
          : {};
        const daySlots = Array.isArray(slots[cleanDay]) ? [...slots[cleanDay]] : [];
        const slotIndex = daySlots.findIndex((slot) => slot.time === cleanTime);

        if (slotIndex === -1) {
          return { ok: false, error: 'No se encontro el turno.' };
        }

        const slot = structuredClone(daySlots[slotIndex]);

        const rIndex = slot.reservations.findIndex(
          (r) => normalizeUserId(r.userId) === cleanTarget
        );
        if (rIndex === -1) {
          return { ok: false, error: 'No hay solicitud de ese usuario en este turno.' };
        }

        const row = slot.reservations[rIndex];
        if (row.approvalStatus !== RESERVATION_APPROVAL.PENDING) {
          return { ok: false, error: 'Esta entrada ya no esta pendiente.' };
        }

        if (approve) {
          const validationSlot = {
            ...slot,
            reservations: slot.reservations
              .filter((_, idx) => idx !== rIndex)
              .map((reservation) => ({ ...reservation }))
          };
          const validation = validateReservation(
            validationSlot,
            row.name,
            row.point,
            Array.isArray(row.companions) ? row.companions : []
          );
          if (!validation.ok) {
            return { ok: false, error: `No se puede aprobar: ${validation.error}` };
          }

          slot.reservations[rIndex] = {
            ...row,
            companions: validation.companions,
            approvalStatus: RESERVATION_APPROVAL.APPROVED
          };
        } else {
          slot.reservations.splice(rIndex, 1);
        }

        slot.status = computeStatus(slot);
        daySlots[slotIndex] = slot;
        slots[cleanDay] = daySlots;

        transaction.set(ref, {
          items: slots,
          updatedAt: serverTimestamp()
        }, { merge: true });

        return { ok: true };
      });

      return { ...result, offline: !isOnline };
    } catch (error) {
      console.error(error);
      return { ok: false, error: 'No se pudo actualizar la solicitud.' };
    }
  },

  async getUserReservationsAcrossPoints(userId) {
    const cleanUserId = normalizeUserId(userId);
    if (!cleanUserId) return [];

    const points = await loadAllPoints();
    const pointSources = await loadPointSources(points);
    return collectUserReservationsAcrossPoints(cleanUserId, pointSources);
  },

  async reassignUserToPoint(uid, newPointId, newReservation) {
    const cleanUserId = normalizeUserId(uid);
    const cleanPointId = String(newPointId ?? '').trim();

    if (!cleanUserId || !cleanPointId) {
      return { ok: false, error: 'Solicitud de cambio de punto invalida.' };
    }

    if (!newReservation?.day || !newReservation?.time) {
      return { ok: false, error: 'La nueva reserva debe incluir dia y horario.' };
    }

    const points = await loadAllPoints();
    const targetPoint = points.find((point) => point.id === cleanPointId);
    if (!targetPoint) {
      return { ok: false, error: 'No se encontro el punto destino.' };
    }

    const assignedSubadmin = targetPoint.subadminId
      ? {
        id: targetPoint.subadminId,
        displayName: targetPoint.subadminName ?? ''
      }
      : await resolvePointSubadmin(cleanPointId);

    if (!assignedSubadmin?.id) {
      return { ok: false, error: 'No hay capitán asignado para este punto.' };
    }

    try {
      const result = await runTransaction(db, async (transaction) => {
        const userRef = userDocRef(cleanUserId);
        const userSnapshot = await transaction.get(userRef);
        const pointEntries = [];

        for (const point of points) {
          const ref = pointDataRef(point.id, POINT_DATA_DOCS.SLOTS);
          const snapshot = await transaction.get(ref);
          pointEntries.push({
            point,
            ref,
            slots: snapshot.exists()
              ? sanitizeSlots(point.id, snapshot.data().items ?? {})
              : {}
          });
        }

        let removedReservations = 0;

        pointEntries.forEach((entry) => {
          if (entry.point.id === cleanPointId) return;

          const removal = removeUserReservationsFromSlots(entry.slots, cleanUserId);
          if (!removal.changed) return;

          removedReservations += removal.removedCount;
          entry.slots = removal.slots;
          transaction.set(entry.ref, {
            items: entry.slots,
            updatedAt: serverTimestamp()
          }, { merge: true });
        });

        const targetEntry = pointEntries.find((entry) => entry.point.id === cleanPointId);
        if (!targetEntry) {
          return { ok: false, error: 'No se pudo cargar el punto destino.' };
        }

        const daySlots = Array.isArray(targetEntry.slots[newReservation.day])
          ? [...targetEntry.slots[newReservation.day]]
          : [];
        const slotIndex = daySlots.findIndex((slot) => slot.time === newReservation.time);

        if (slotIndex === -1) {
          return { ok: false, error: 'No se encontro el turno solicitado en el nuevo punto.' };
        }

        const slot = structuredClone(daySlots[slotIndex]);

        const upsertResult = upsertReservationForUser(slot, {
          ...newReservation,
          userId: cleanUserId,
          pointId: cleanPointId,
          point: targetPoint.name ?? newReservation.point ?? '',
          assignedSubadminId: assignedSubadmin.id,
          assignedSubadminName: assignedSubadmin.displayName || assignedSubadmin.email || assignedSubadmin.id,
          approvalStatus: RESERVATION_APPROVAL.PENDING
        });

        if (!upsertResult.ok) return upsertResult;

        daySlots[slotIndex] = slot;
        targetEntry.slots[newReservation.day] = daySlots;

        transaction.set(targetEntry.ref, {
          items: targetEntry.slots,
          updatedAt: serverTimestamp()
        }, { merge: true });

        transaction.set(userRef, mergeUserAssignedPointFields({
          ...(userSnapshot.exists() ? userSnapshot.data() : {}),
          assignedPointId: cleanPointId,
          assignedPointName: targetPoint.name ?? '',
          assignedSubadminId: assignedSubadmin.id,
          assignedSubadminName: assignedSubadmin.displayName || assignedSubadmin.email || assignedSubadmin.id,
          updatedAt: serverTimestamp()
        }), { merge: true });

        return {
          ok: true,
          mode: upsertResult.mode,
          removedReservations
        };
      });

      return { ...result, offline: !isOnline };
    } catch (error) {
      console.error(error);
      return { ok: false, error: 'No se pudo reasignar el usuario al nuevo punto.' };
    }
  },

  async cancelOwnReservation({ pointId, day, time, actor }) {
    const actorUserId = normalizeUserId(actor?.uid);
    if (!pointId || !day || !time || !actorUserId) return { ok: false, error: 'Solicitud invalida.' };
 
    try {
      const result = await runTransaction(db, async (transaction) => {
        const ref = pointDataRef(pointId, POINT_DATA_DOCS.SLOTS);
        const slotsSnapshot = await transaction.get(ref);
        const slots = slotsSnapshot.exists()
          ? sanitizeSlots(pointId, slotsSnapshot.data().items ?? {})
          : {};
        const daySlots = Array.isArray(slots[day]) ? [...slots[day]] : [];
        const slotIndex = daySlots.findIndex((slot) => slot.time === time);
        if (slotIndex === -1) return { ok: false, error: 'No se encontro el turno solicitado.' };
 
        const slot = structuredClone(daySlots[slotIndex]);
        const removeResult = removeReservationByUser(slot, actorUserId);
        if (!removeResult.ok) return removeResult;
 
        daySlots[slotIndex] = slot;
        slots[day] = daySlots;
 
        transaction.set(ref, {
          items: slots,
          updatedAt: serverTimestamp()
        }, { merge: true });
 
        return { ok: true };
      });
 
      return { ...result, offline: !isOnline };
    } catch (error) {
      console.error(error);
      return { ok: false, error: 'No se pudo cancelar la reserva.' };
    }
  },
 
  async setReports(pointId, reports) {
    if (!pointId) return { ok: false, error: 'Punto invalido.' };
 
    await setDoc(pointDataRef(pointId, POINT_DATA_DOCS.REPORTS), {
      items: reports,
      updatedAt: serverTimestamp()
    }, { merge: true });
 
    return { ok: true, offline: !isOnline };
  }
};
                            
