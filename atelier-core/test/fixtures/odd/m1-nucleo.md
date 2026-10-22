# M1 – Núcleo mínimo con el backend Claude Code

Hito M1 de `docs/roadmap.md`. El diseño aprobado es `docs/m1-diseno.md`: es la especificación detallada de cada pieza y los workers lo leen completo.
Código en el repo `atelier/` (monorepo pnpm), rama `feat/m1`, un commit por unidad. Integrado en `main` (fast-forward a `23d2f43`, 2026-10-22, pedido del usuario: "pasa los cambios a main").

## Specs

- **S1** — Pedido del usuario, textual: "ok, los 4" (confirma las cuatro decisiones de `docs/m1-diseno.md`: Node 22 LTS mínimo, Biome, Opus por defecto, quitar `ANTHROPIC_API_KEY` del proceso hijo).
- **S2** — Layout, textual: "crea un directorio que se llame atelier y ali vas creando, atelier-cli, atelier-core y atelier-desktop" y "perfecto, un solo repo entonces". Un solo repo git en `atelier/`; paquetes `atelier-core` (`@atelier/core`), `atelier-cli` (`@atelier/cli`), `atelier-desktop` (`@atelier/desktop`, M2).
- **S3** — Objetivo de M1 (`docs/m1-diseno.md`, "Objetivo"): `atelier "agregá validación de email en src/user.ts y corré los tests"` funciona contra la suscripción Max usando solo las herramientas de Atelier, mostrando texto en streaming, cada herramienta y los tokens del turno.
- **S4** — Contrato de eventos e interfaz `AgentBackend` tal como están en `docs/m1-diseno.md` ("Contrato de eventos", "Interfaz AgentBackend"). El núcleo nunca escribe en la terminal; los errores siempre salen como evento `error`.
- **S5** — Herramientas `read`, `edit`, `bash`, `grep` según la tabla "Herramientas" de `docs/m1-diseno.md`; rutas confinadas a `cwd`; `bash` pide confirmación salvo `--yes`.
- **S6** — Backend Claude Code según la tabla "Backend Claude Code" de `docs/m1-diseno.md`; `mapSdkMessage` es función pura testeada con fixtures.
- **S7** — CLI según "CLI" de `docs/m1-diseno.md`.
- **S8** — Criterios de terminado 1–5 de `docs/m1-diseno.md`. Ningún test automático usa red ni cuota.

## Tasks

| ID | Specs | Ruta | Entregable | Commit |
|---|---|---|---|---|
| U1 | S1, S2 | inline | Base del repo: pnpm workspace, tsconfig, Biome, Vitest, paquetes vacíos | `890dac8` — hecho |
| U2 | S4 | inline | `AtelierEvent`, `AgentBackend`, `Session`, `FakeBackend` y tests | `d0f9ed7` — hecho |
| U3 | S5 | inline + gentle-ai-verify | Herramientas y confinamiento de rutas, con tests | `6ef6794` — hecho; verify FAIL→corregido; revisión nativa `review-424912148ebf4977` aprobada y acusada |
| U4 | S6 | inline + gentle-ai-verify | `ClaudeCodeBackend`, `mapSdkMessage`, fixtures y tests | `9d76bbb` + `bcab9ee` — hecho; verify con 2 bloqueos→corregidos; RDD assess medio, sin revisión |
| U5 | S7 | inline | CLI: comando suelto, interactiva, render, confirmación | `451cec2` — hecho; revisión nativa `review-53b1ebf4487dfacf` aprobada y acusada |
| U6 | S3, S8 | inline | Prueba real, fixtures definitivas, README | `7342cfd` + `c7acdfe` + `52c477f` — prueba real OK; revisión nativa `review-a922b4bbd37ad13f` → corrección `52c477f` → recover `scope_changed` → `review-13aa74ca87425907` aprobada y acusada — hecho |
| U3b | S5 | inline + gentle-ai-verify | Endurecer herramientas con los hallazgos no bloqueantes de la revisión (ver L4) | `cce1180` + `1be2f45` + `b862c8d` + correcciones del verificador (L12) — hecho |
| U5b | S7 | inline | Endurecer Ctrl+C y salida de la CLI con los hallazgos de la revisión (ver L7) | `a2a7582` + `6cf9968` (lector de aprobación, L10) — hecho |

## Log

- **L1** — "ok, los 4" (respuesta a: "¿Van las cuatro?" sobre las decisiones de `docs/m1-diseno.md`).
- **L2** — Layout decidido antes: un solo repo en `atelier/` tras evaluar repos separados.
- **L3** — U3: gentle-ai-verify dio FAIL sobre el snapshot previo (carrera de symlinks, pérdida del tail de bash, truncado por caracteres en read, crash si falla TMPDIR). Corregidos con tests; la carrera de symlinks queda como riesgo residual aceptado y documentado en `docs/m1-diseno.md` (no hay `openat` en Node).
- **L4** — Revisión nativa de U3 aprobada con hallazgos no bloqueantes: R1-bash-temp-disk-leak (bash.ts:59), R1-grep-redos (grep.ts:56), R1-path-race (paths.ts:38-40), R1-unbounded-file-reads (read.ts:19-20), R3-phantom-final-line (grep.ts:66), R3-recursive-glob-boundary (grep.ts:26-29), R3-search-read-errors (grep.ts:64), R3-spill-backpressure (bash.ts:37-43), R4-bash-spill-unbounded (bash.ts:34-44), R4-grep-ignores-abort (grep.ts:113-118). Van a U3b.
- **L5** — Al instalar el Agent SDK, pnpm 12 agregó `minimumReleaseAgeExclude` en `pnpm-workspace.yaml` para `@anthropic-ai/claude-agent-sdk@0.3.308` y sus binarios: exceptúa la protección contra paquetes recién publicados. Decisión del usuario: "Mantener la excepción fijada a 0.3.308" (commit `9d76bbb`).
- **L6** — U4: gentle-ai-verify encontró EOF sin error y cancelación sin límite (bloqueos), `apiKeySource: none` ≠ suscripción, y consumo indebido de ids en el puente. Corregido en `bcab9ee`; `authSource` ahora se confirma con `accountInfo()` y admite `other`. Riesgo residual: otras credenciales (`ANTHROPIC_AUTH_TOKEN`, nube) pueden facturar; la CLI debe avisar si `authSource !== "subscription"`.
- **L7** — Revisión nativa de U5 aprobada con hallazgos no bloqueantes: R4-approval-blocks-interrupt (run.ts:79: Ctrl+C durante la pregunta de aprobación no la corta), R4-interrupt-exit-skips-close (run.ts:86-94: el segundo Ctrl+C sale sin cerrar la sesión; puede dejar huérfano el proceso de Claude Code), R4-process-exit-truncation (main.ts:17: `process.exit` puede truncar stdout en pipes), R2-sigint-process-exit (run.ts:84-90), R2-prompt-join (args.ts:41-42), R2-args-return-type (run.ts:33). Van a U5b.
- **L8** — Decisión del usuario sobre U6: "Primero U5b, después la corro yo" (la prueba real contra la suscripción la corre el agente, después de U5b).
- **L9** — U6: prueba real OK (26 s, solo `mcp__atelier__*`, `npm test` 3/3, `subscription`, $0.0712). Hallazgos: memoria automática de Claude Code activa → `autoMemoryEnabled: false` (`7342cfd`, verificado en real); salida duplicada en la CLI una vez, no reproducida (abierto). La corrida previa al arreglo dejó directorios vacíos de memoria en `~/.claude/projects/-Users-lola-Projects-gentle-shell-pi-desktop-scratch-m1-demo/memory` (y posiblemente `...-scratch-repro/memory`), fuera del proyecto: no se borraron. Revisión nativa de U5b+U6: hallazgo crítico R3-force-exit (el timer de salida forzada se desarmaba antes de esperar el cierre) → corregido en `52c477f` con tests (128 en verde); la corrección tocó `session.ts` → el proveedor pide `recover` con disposición `scope_changed`; el facade rechaza el `input` (exige string y la interfaz lo convierte en objeto).
- **L10** — Usuario: "corre el comando nativo". Se ejecutó el `gentle-ai review recover` exacto emitido por el proveedor con el binario empaquetado (v4.2.0) y su entorno de bundle; sucesora `review-13aa74ca87425907` aprobada y acusada (`burned`). Hallazgos no bloqueantes: R3-001 (run.ts:89) y R4-approval-stale-reader (run.ts:86-90): tras cancelar una aprobación, el `lines.next()` pendiente queda vivo y puede tragarse la próxima línea. Van a seguimiento.
- **L11** — Usuario: "si, hazlo" (arreglos 1 y 2 y borrar los directorios vacíos de `~/.claude/projects`). Borrados con `rmdir` tras verificar que estaban vacíos.
- **L12** — U3b: directorio temporal por sesión (`cce1180`), `read` por streaming (`1be2f45`), `grep` siempre en subproceso con `grep -E` del sistema como fallback (`b862c8d`; el fallback JS colgaba el proceso con `(a+)+$`). RDD assess medio, sin revisión; por ser cambio de guarda (ítem 2) se corrió gentle-ai-verify: FAIL con 5 defectos (NUL tardío, abort durante validación, globs con directorio en el fallback, fuga del directorio temporal si falla start o close síncrono) + salida de grep sin tope de bytes. Corregidos con los tests de regresión del verificador. 154 tests en verde. `R1-path-race` sigue aceptado y documentado.
- **L13** — Usuario: "borra la rama e inicia la investigacion de la salida duplicada". Rama `feat/m1` borrada (`git branch -d`, ya integrada en `main`). Investigación: `scratch/m1-real.stdout` (1 189 bytes) tiene el encabezado y cada línea de herramienta una sola vez. La "duplicación" la produjo el comando de diagnóstico `head -5 job-3.log; echo; cat m1-real.stdout`: las 5 primeras líneas del log del job (exit, "--- stdout", encabezado, 2 herramientas) seguidas de una línea vacía y del archivo completo. Falsa alarma; cerrado sin cambios de código.
