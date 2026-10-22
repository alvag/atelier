# M4 – Subagentes

Hito M4 de `docs/roadmap.md`. El diseño aprobado es `docs/m4-diseno.md`: los workers lo leen completo.
Código en `atelier/`, rama `feat/m4`, un commit por unidad (≈400 líneas máx.).

## Specs

- **S1** — Pedido del usuario, textual: "si, van los 6" (respuesta a "¿Van las seis, o querés cambiar alguna?"; decisiones de `docs/m4-diseno.md`: sesión hija en el mismo proceso; dos definiciones incluidas, `explorer` y `worker`, sin archivos propios; `explorer` con el modelo más barato y `worker` con el del padre; informe acotado en código a 8 000 caracteres con marcador; sin background ni paralelo; protocolo 2).
- **S2** — Criterio del roadmap, textual: "el agente delega una exploración a un subagente, solo el informe acotado entra al contexto del padre, la interfaz muestra la actividad del subagente anidada y con sus tokens, y el efecto en el contexto del padre está medido".
- **S3** — Núcleo según "Arquitectura" y "Contrato" de `docs/m4-diseno.md`: `task({ agent, prompt })` implementada por `Session`; sesión hija con el mismo tipo de backend, contexto propio, herramientas de su definición, sin `task`; informe = último texto del hijo, ≤ 8 000 caracteres más `[report truncated at 8000 characters]`; hijo que falla, se interrumpe o no produce texto → `tool_result` de error con el motivo.
- **S4** — Eventos y control: eventos del hijo dentro del turno del padre con `parentCallId` y `agent`; `turn_finished` del hijo aparte; el del padre sin los tokens del hijo; confirmaciones del hijo por el mismo canal y `autoApprove` heredado; interrumpir y cerrar se propagan; protocolo versión 2.
- **S5** — Clientes: CLI con las líneas del hijo sangradas; desktop con un bloque plegable por subagente con sus herramientas y tokens.
- **S6** — Criterios de terminado 1–5 de `docs/m4-diseno.md`. Ningún test automático usa red ni cuota.

## Tasks

| ID | Specs | Ruta | Entregable | Commit |
|---|---|---|---|---|
| U1 | S1, S3 | inline | Definiciones, `task` en `Session`, sesión hija, informe acotado, tests con `FakeBackend` | `fad9abf` — hecho (393 líneas); assess medio, sin revisión nativa |
| U2 | S4 | inline | `parentCallId`/`agent`, confirmaciones, interrupción y cierre del hijo, protocolo 2, test de contexto con `anthropic-api` | `89ad62d` — hecho (309 líneas); assess medio, sin revisión nativa |
| U3 | S5 | inline | CLI y desktop anidadas, tokens del hijo, smoke | `1372567` — hecho (505 líneas: no se partió para no separar CLI, desktop y sus tests de una misma presentación); smoke con eco OK; assess medio, sin revisión nativa |
| U4 | S2, S6 | inline | Prueba real con los dos backends, guion de medición, `docs/m4-medicion.md`, README | `68c6a30` + `f12ce43` (arreglo R3-001) — hecho; revisión nativa `review-3eab3ec62f3c7c4a` (reliability, readability) aprobada y acusada |

## Cortes de entrega

Cada unidad es un commit revisable de ≈400 líneas o menos; si se pasa, se parte. Integrar `feat/m4` en `main` queda para el usuario.

## Log

- **L1** — "si, van los 6" (respuesta a "¿Van las seis, o querés cambiar alguna?").
- **L2** — U1: `task` es una `ToolDefinition` cuyo `execute` llama a `Session.#runSubagent`; el hijo recibe sus herramientas en el orden de la definición y nunca `task` (guarda y test escritos juntos: ese test no se vio en rojo). `BackendStartOptions.maxRequestsPerTurn` nuevo: `anthropic-api` lo respeta y Claude Code lo pasa como `maxTurns`. El informe es el texto posterior a la última herramienta del hijo. 354 tests verdes.
- **L3** — U2: los eventos del hijo entran al canal del turno del padre sin su `seq`/`turnId`, con `parentCallId` (el `callId` del `task`, que ahora llega en `ToolContext`) y `agent`. La interrupción llega al hijo solo por la señal de abort de la herramienta: llamarlo además directo lo interrumpía dos veces (lo atrapó el test). `RpcServer` da subagentes a toda sesión (`subagents` opcional, default `BUILTIN_AGENTS`). El test de contexto con `anthropic-api` se escribió después de implementar (caracterización, no se vio en rojo). 361 tests verdes. La CLI todavía no activa subagentes (U3).
- **L4** — U3: la CLI activa subagentes con el backend de `--backend`; el hijo se imprime bajo `  ↳ agente · modelo` con `  │ ` en cada línea, y su error no marca fallido el turno del padre. La desktop anida el hijo en el ítem `tool` del `task` (`subagent: { agent, model, items, finished }`) con un reductor de ítems compartido; el bloque queda abierto mientras corre o espera una confirmación. Cambio buscado en un test existente: la CLI ahora ofrece `task` además de `read`, `edit`, `bash`, `grep`. 366 tests y smoke verdes.
- **L5** — U4. Medición (`atelier-core/scripts/measure-subagents.ts`, `scratch/m4-measure-1.json`): delegando, el padre usó 5 719 tokens de prompt contra 12 560 (−54%) y 2 peticiones contra 4; la pregunta costó $0.0281 contra $0.0268 (+5%; el hijo en Haiku, $0.0022); el seguimiento arrastró 5 273 contra 5 811 tokens (−9%), porque el informe ocupó casi lo mismo que los archivos chicos que reemplazó. Pruebas reales: CLI con `anthropic-api` (hijo 3 peticiones, $0.0007, informe 1 514 caracteres) y con `claude-code` (hijo 6 peticiones, informe 1 862); desktop con los dos (1 bloque de subagente cada una, informes de 1 331 y 1 695 caracteres). En la desktop con `anthropic-api` el hijo intentó `read .` ("Not a file") y siguió. Arreglos durante U4: líneas en blanco del hijo sin `│` en la CLI, y el smoke real esperaba la primera línea `tokens:` (podía ser la del hijo). Revisión nativa de U4 aprobada con avisos: R3-001 (render.ts:109, línea en blanco partida entre deltas sin `│`) → corregido en `f12ce43` con test visto en rojo; quedan como seguimiento R3-002 (measure-subagents.ts:97-102, costos indefinidos sumados como 0, igual que R3-001 de M3) y sugerencias R2-answer-reset y R2-blank-line-handling.
- **L6** — M4 cumple los criterios 1–5 de `docs/m4-diseno.md`; 366 tests y smoke verdes. Integrar `feat/m4` en `main` queda para el usuario.
- **L7** — "hazlo" (respuesta a "¿Integro `feat/m4` en `main` y borro la rama, como hicimos con M3?"): `feat/m4` integrado en `main` por fast-forward (`7a3cd61..f12ce43`) y borrada. `pnpm check` en `main`: 366 tests verdes.
