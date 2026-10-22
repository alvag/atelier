# M2 – Protocolo e interfaz básica

Hito M2 de `docs/roadmap.md`. El diseño aprobado es `docs/m2-diseno.md`: los workers lo leen completo.
Código en `atelier/`, rama `feat/m2`, un commit por unidad (≈400 líneas máx.).

## Specs

- **S1** — Pedido del usuario, textual: "confirmo las 5 decisiones" (las de `docs/m2-diseno.md`: transporte stdio con JSONL; servidor dentro de `@atelier/core` como `atelier-core serve`; la CLI no pasa al protocolo en M2; React + electron-vite; una sesión visible a la vez).
- **S2** — Criterio del roadmap, textual: "la desktop chatea con el núcleo, que corre como proceso aparte, y los errores del núcleo llegan a la interfaz sin perderse".
- **S3** — Protocolo según "Protocolo" de `docs/m2-diseno.md`: saludo `hello` con `protocol: 1`; todo comando lleva `id` y recibe exactamente una respuesta; eventos envueltos con `sessionId`; confirmaciones por `session.approve`, que responden "no" si la sesión se cierra, el turno se interrumpe o el cliente se desconecta; `protocol_error` para líneas ilegibles; stdout exclusivo del protocolo.
- **S4** — Cliente: `RpcClient` en `@atelier/core`; rechaza los pendientes con `core_exited` si el proceso muere.
- **S5** — Desktop según "Arquitectura" e "Interfaz" de `docs/m2-diseno.md`.
- **S6** — Criterios de terminado 1–4 de `docs/m2-diseno.md`. Ningún test automático usa red ni cuota.

## Tasks

| ID | Specs | Ruta | Entregable | Commit |
|---|---|---|---|---|
| U1 | S3 | inline | Tipos del protocolo y codec JSONL, con tests | `eac676a` — hecho |
| U2 | S3 | inline | `RpcServer` y `atelier-core serve`, con tests sobre `FakeBackend` | `7eb7176` (servidor) + `5fd56cb` (entrada `serve`) + `2075903` (corrección) — hecho; revisión nativa `review-6a551befdcc41e10` aprobada y acusada |
| U3 | S4 | inline | `RpcClient` con ciclo de vida del proceso, con tests | `0e1f0f0` — hecho; revisión `review-3cdde24c56cd7d5c` aprobada y acusada (junto con U2b) |
| U4 | S5 | inline | Desktop: base electron-vite + React, `CoreHost`, preload | `e2da5e0` (CoreHost + puente) + `92700e5` (app Electron) + corrección del verificador (L5) — hecho |
| U5 | S5 | inline + gentle-ai-verify | Desktop: reductor e interfaz de chat | `5815a84` (reductor) + `428f417` (Markdown) + `98e096d` (interfaz) + `43d34e3` (guardas main) + `82bbbfe` (correcciones del verificador) — hecho |
| U6 | S2, S6 | inline | Smoke test, prueba real, README | `13ded5a` — hecho; revisión `review-310acde718b5f05e` (F1+U6) aprobada y acusada |
| U2b | S3 | inline | Hallazgos no bloqueantes de la revisión de U2 (ver L2) | `1d09f84` — hecho |
| F1 | S5 | inline | CLI de M1: mostrar el comando de aprobación con caracteres ocultos visibles (ANSI y bidi), como la desktop (ver L6) | `f461f42` — hecho |

## Cortes de entrega

Cada unidad es un commit revisable de ≈400 líneas o menos; si se pasa, se parte. Cortes hasta ahora: `eac676a` (U1), `7eb7176` (U2 servidor), `5fd56cb` (U2 `serve`), `2075903` (corrección U2), `0e1f0f0` (U3), `1d09f84` (U2b), `e2da5e0` + `92700e5` + `77f07b6` (U4), `5815a84`, `428f417`, `98e096d` (≈530 líneas, no se partió para no separar código y tests), `43d34e3`, `82bbbfe` (U5). La rama `feat/m2` se integra en `main` al cerrar el hito, como en M1.

## Log

- **L1** — "confirmo las 5 decisiones" (respuesta a "¿Van las cinco, o querés cambiar alguna?").
- **L2** — Revisión nativa de U2: hallazgo crítico R3-start-cleanup-race (un `session.start` en curso al cortarse la entrada dejaba una sesión sin cerrar) → corregido en `2075903` con test; validación dirigida aprobada. Avisos no bloqueantes para U2b: R1-rpcserver-unbounded-state (rpc-server.ts:50-51, el set de ids usados crece sin límite), R4-runturn-unhandled-rejection (rpc-server.ts:189-195, `void #runTurn` sin `catch`), R4-start-after-closeall (rpc-server.ts:184-185).
- **L3** — Revisión de U3+U2b aprobada. Avisos no bloqueantes: R3-duplicate-window (rpc-server.ts:112-115: con el límite de 10 000 ids, un id muy viejo se puede reutilizar) y R3-startup-diagnostics-race (rpc-client.test.ts:97-109: el test de errores de protocolo depende de un sleep de 100 ms). Quedan anotados; no bloquean U4.
- **L4** — U4: Electron 45 trae Node 24.22; el núcleo corre con `ELECTRON_RUN_AS_NODE=1` (probado con `serve`), así que no hace falta el `node` del sistema (riesgo del diseño resuelto). `--filter` de pnpm no encontró el paquete recién agregado al workspace e instaló nada sin error; con `-C atelier-desktop` funcionó. Partir commits con `git stash` dispara la auto-instalación de pnpm 12 al correr scripts: hay que reinstalar (`pnpm install --offline`) al hacer `stash pop`.
- **L5** — U4: RDD medio, sin revisión nativa; por ítems 2 y 5 se corrió gentle-ai-verify: aislamiento del renderer, navegación y dependencias OK; 3 bloqueos (conexiones huérfanas con start/restart/stop encimados, estado de arranque perdido antes de suscribirse o al recargar, CSP que rompía el modo dev) + aviso preexistente (un comando con `id` propio pisaba el de RpcClient). Corregidos con los tests del verificador. Pendiente para U5: los enlaces dentro de la ventana se cancelan en vez de abrirse afuera; validar en main el comando que llega por IPC. Riesgo residual: si el proceso principal muere con SIGKILL, el núcleo sale al cerrarse el pipe (medido: 22 ms), pero no se verificó que los procesos de Claude Code hijos del núcleo también salgan.
- **L6** — U5: RDD medio; por ser barrera de seguridad (Markdown → HTML, IPC) se corrió gentle-ai-verify: 25 payloads XSS sin escape en jsdom (paridad con Chromium sin verificar: headless Chrome no arrancó offline), CSP de producción como segunda capa. 2 bloqueos corregidos en `82bbbfe`: `parseCommand` lanzaba con datos circulares/BigInt (ahora `invalid_command`) y la tarjeta de aprobación mostraba controles bidi que reordenan visualmente el comando (ahora se ven como marcadores con aviso, y el comando se ajusta en vez de desplazarse). DOMPurify sanea mal sobre happy-dom (dejó un `<script>`): los tests de Markdown corren con jsdom. Seguimiento F1: la CLI de M1 imprime el comando de aprobación crudo en la terminal (ANSI se interpreta). No verificado: `428f417` se commiteó antes de correr el check sobre su estado aislado (el estado siguiente sí pasó).
- **L7** — Usuario eligió "Hacé todo vos" para U6. Smoke con eco: pasa (turno, aprobación, herramienta, el núcleo termina al cerrar). Prueba real desde la desktop sobre `scratch/m2-demo` con el pedido del objetivo: 18 s, 6 herramientas Atelier con ✓, `npm test` 3/3, sin aviso de suscripción, `tokens: input 8 · output 1,247 · cache read 10,396 · cache write 4,800 · $0.0655`, el núcleo terminó al cerrar. Revisión nativa de F1+U6 aprobada con avisos: el modo real del smoke aprueba todo (R1-autoapprove-real-smoke), `ATELIER_E2E_FOLDER` es un hook de test en producción (R1-e2e-folder-env-override), el bucle de aprobación del smoke no tiene timeout propio (R3-001).
- **L8** — Incidente: apareció un `.git` vacío en el laboratorio a las 14:36:46 (entre el smoke y la prueba real); ningún comando del agente ni de Atelier hizo `git init`; causa no determinada. Usuario: "Sí, borralo" → borrado tras verificar 0 commits y 0 archivos trackeados.
- **L9** — M2 integrado en `main` (fast-forward).
