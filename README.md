# 📖 PredicApp — Gestión de Turnos de Exhibidores

PWA para coordinar turnos semanales de predicación. Funciona completamente offline una vez instalada.

## Estructura del proyecto

```
predicapp/
├── index.html          # Entry point
├── app.js              # Controlador principal
├── config.js           # Constantes globales (DAYS, TIMES, etc.)
├── db.js               # Capa de almacenamiento (localStorage)
├── auth.js             # Autenticación con hash SHA-256
├── reservations.js     # Lógica de negocio de reservas
├── ui.js               # Capa de presentación
├── toast.js            # Notificaciones no bloqueantes
├── style.css           # Estilos globales
├── sw.js               # Service Worker (PWA offline)
├── manifest.json       # Metadatos PWA
└── assets/
    ├── icons/
    │   ├── icon-192x192.png
    │   └── icon-512x512.png
    └── offline.html    # Página sin conexión
```

## Uso

Sirve los archivos desde cualquier servidor HTTP estático. No requiere build ni dependencias.

```bash
# Opción 1 — Python
python3 -m http.server 8080

# Opción 2 — Node
npx serve .

# Opción 3 — VS Code
# Extensión Live Server → clic derecho en index.html → "Open with Live Server"
```

> ⚠️ El Service Worker requiere HTTPS en producción (o `localhost` en desarrollo).

## Contraseña de administrador

Por defecto: **`admin`**

Cámbiala desde el panel Admin → sección "Cambiar contraseña". Las contraseñas se almacenan como hash SHA-256; nunca en texto plano.

## Tecnologías

- Vanilla JS con ES Modules (`type="module"`)
- Web Crypto API para hashing de contraseñas
- Service Worker con estrategia Cache First
- localStorage como base de datos local
- Sin frameworks, sin dependencias, sin build step
