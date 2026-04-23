# 📖 PredicApp — Gestión de Turnos de Exhibidores

PWA para coordinar turnos semanales de predicación. Funciona offline una vez instalada gracias a Firestore con persistencia en IndexedDB.

## Estructura del proyecto

```
predicapp/
├── index.html          # Entry point + todos los modales
├── app.js              # Controlador principal + event listeners
├── config.js           # Constantes globales (DAYS, TIMES, capacidad, etc.)
├── db.js               # Capa de datos — Firestore + cache local
├── auth.js             # Firebase Authentication (email/Google)
├── reservations.js     # Lógica de negocio de turnos
├── reports.js          # Módulo de reportes + generación de PDF (jsPDF)
├── ui.js               # Capa de presentación (tabla desktop + cards móvil)
├── toast.js            # Notificaciones, confirm y prompt no bloqueantes
├── style.css           # Estilos globales
├── sw.js               # Service Worker (PWA offline) — cache v3.0
├── manifest.json       # Metadatos PWA
├── vercel.json         # Configuración de despliegue en Vercel
└── assets/
    └── icons/
        ├── icon-192x192.png
        └── icon-512x512.png
```

## Lógica de turnos

Cada turno admite **mínimo 2 y máximo 3 personas**. Al reservar se selecciona:
- Un **participante principal**
- Un **compañero** (obligatorio)
- Un **segundo compañero** (opcional)

Estados de un turno:

| Estado     | Personas | Color                    |
|------------|----------|--------------------------|
| `free`     | 0        | Gris                     |
| `partial`  | 1        | Amarillo                 |
| `ready`    | 2        | Verde                    |
| `complete` | 3        | Verde oscuro (bloqueado) |

Los nombres de los participantes asignados se muestran directamente en cada celda del tablero (desktop y móvil).

## Funcionalidades

### Tablero público
- Vista semanal con estado visual por turno
- Nombres de los participantes visibles en cada celda
- Botón **Reservar** en turnos con cupo disponible
- Botón **📋 Registrar / Ver reporte** en turnos con participantes asignados

### Administrador
Acceso con contraseña desde el botón 🔐 Admin del header.

- **Cancelar turno** — libera todas las reservas del turno
- **Editar turno** — elimina reservas individuales dentro de un turno
- **Gestionar participantes** — agregar y eliminar
- **Gestionar puntos** — agregar y eliminar
- **Cambiar contraseña** de administrador
- **Exportar PDF** con todos los reportes registrados

### Reportes de turno
Cada turno con participantes asignados permite registrar:

| Campo              | Tipo     | Descripción                              |
|--------------------|----------|------------------------------------------|
| Fecha              | fecha    | Fecha en que se realizó el turno         |
| Hora de inicio     | hora     | Hora real de inicio                      |
| ¿Se cumplió?       | sí/no    | Si el turno se llevó a cabo              |
| ¿Conversaciones?   | sí/no    | Si se inició alguna conversación         |
| ¿Estudio bíblico?  | sí/no    | Si se hicieron arreglos para estudio     |
| Revisitas          | número   | Cantidad de revisitas realizadas         |
| Estudios           | número   | Cantidad de estudios activos             |
| Notas              | texto    | Observaciones libres del turno           |

Los turnos con reporte registrado muestran el badge 📋 en el tablero.

### Generación de PDF
- Genera PDF en el navegador (sin backend) usando **jsPDF** cargado desde CDN de forma lazy
- Incluye: participantes, punto, fecha, hora, resultados y notas
- **Compartir** si el dispositivo soporta Web Share API (Android/iOS con HTTPS)
- **Descarga directa** como fallback
- Disponible por turno individual o como exportación de todos los reportes

## Estructura de datos en Firestore (versión actual)

La app (`db.js`, `config.js`) usa el **modelo con Firebase Auth** y estas colecciones en la base `(default)`:

| Ruta | Uso |
|------|-----|
| `users/{uid}` | Perfil: `role`, `adminApproved`, `assignedPointIds`, etc. |
| `allowed_emails/{email}` | Lista blanca de correos (id = correo en minúsculas). |
| `points/{pointId}` | Metadatos del punto (nombre, subadmin, …). |
| `points/{pointId}/data/participants` | Lista de participantes (`items`). |
| `points/{pointId}/data/slots` | Grilla de turnos (`items` por día). |
| `points/{pointId}/data/reports` | Reportes (`items`). |

Las reglas vigentes están en el archivo **`firestore.rules`** del repo. Despliégalas con:

```bash
firebase deploy --only firestore:rules
```

### Colección legacy `predicapp_data`

Si en la consola ves **`predicapp_data`** (`slots`, `participants`, `admin_pass_hash`, etc.), es de una **versión antigua** del proyecto. El código actual **no lee esa colección**. Puedes dejarla por historial o borrarla cuando ya no la necesites.

**Importante:** Si en Firebase siguen activas reglas antiguas que terminan en:

```text
match /{document=**} {
  allow read, write: if false;
}
```

(solo permitiendo `predicapp_data`), entonces **`users` y `points` quedan prohibidos** y verás `permission-denied` al iniciar sesión. Sustituye las reglas por las de **`firestore.rules`** (no mezcles el bloque que niega todo con el modelo nuevo).

### Estructura de un reporte (campo en `reports`)

```json
{
  "id":           "Lun-07:00-09:00-1718000000000",
  "slotId":       "Lun-07:00-09:00",
  "day":          "Lun",
  "time":         "07:00-09:00",
  "point":        "Parroquia Central",
  "participants": ["Juan García", "María López"],
  "date":         "2025-06-10",
  "startTime":    "07:15",
  "fulfilled":    true,
  "conversation": true,
  "bibleStudy":   false,
  "revisits":     2,
  "studies":      1,
  "notes":        "Buen clima, mucha afluencia de personas.",
  "createdAt":    1718000000000
}
```

## Despliegue en Vercel

El proyecto es un sitio estático, no requiere build step.

1. Importa el repositorio en [vercel.com](https://vercel.com)
2. Configura:
   - **Framework Preset:** `Other`
   - **Build Command:** *(vacío)*
   - **Output Directory:** *(vacío)*
3. Despliega — el `vercel.json` incluido configura automáticamente los headers del Service Worker y el manifest

> Tras el primer despliegue, agrega tu dominio `.vercel.app` en Firebase Console → **Authentication → Authorized domains**.

## Reglas de seguridad de Firestore

No copies reglas desde documentación antigua. La fuente de verdad es **`firestore.rules`** en la raíz del repositorio (usuarios, lista blanca, puntos y subcolección `data`). Tras editarlas, despliega con `firebase deploy --only firestore:rules` y revisa en consola la pestaña **Reglas** (no solo **Datos**).

## Contraseña de administrador

El acceso de administrador usa **Firebase Authentication** (correo/contraseña o Google) y el campo `role: 'admin'` en `users/{uid}`. No depende de `predicapp_data/admin_pass_hash`.

## Desarrollo local

No requiere dependencias ni build step. Sirve los archivos desde cualquier servidor HTTP estático:

```bash
# Python
python3 -m http.server 8080

# Node
npx serve .

# VS Code
# Extensión Live Server → clic derecho en index.html → "Open with Live Server"
```

> El Service Worker requiere HTTPS en producción o `localhost` en desarrollo.

## Tecnologías

- Vanilla JS con ES Modules (`type="module"`)
- Firebase Firestore (tiempo real + offline con IndexedDB)
- jsPDF 2.5.1 (generación de PDF en cliente, carga lazy desde CDN)
- Web Share API (compartir PDF en móviles)
- Service Worker con estrategia Cache First (v3.0)
- PWA instalable (manifest + iconos)
- Sin frameworks · Sin dependencias npm · Sin build step
