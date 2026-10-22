# M0 – Estudio de los proyectos de origen

Hito M0 de `docs/roadmap.md`. Un documento de estudio por repo en `docs/m0/` y una síntesis en `docs/m0/README.md`, con evidencia `path:line` sobre los repos de `repos/`.
El directorio del proyecto no es un repo git: las tareas registran "sin commit" como evidencia.

## Specs

- **S1** — Pedido del usuario, textual: "bien, ahora si empecemos con el M0, recopila toda la informacion necesaria y que nos pueda servir posteriormente, apoyate de la skill reverse-engineer-anything".
- **S2** — Alcance del M0 según `docs/roadmap.md` (sección "M0 – Estudio"): estudiar pi (loop del agente, proveedores, herramientas); gentle-shell y gentle-ai (cómo se arma el prompt, dónde se colocan los puntos de caché, la compactación, ODD/RDD y los subagentes); PI-Desktop (la interfaz: estructura de componentes, cómo muestra mensajes, streaming y tool calls, cómo maneja sesiones, y qué partes de la UI se pueden reutilizar como idea sin arrastrar su capa de compatibilidad); gentle-shell-desktop (el protocolo RPC con `pi --mode rpc` y el host interactivo); Engram (su contrato, no su código interno: herramientas, tipos de observación, sesiones, `topic_key`, y cuándo y qué guarda el agente).
- **S3** — Confirmar o descartar cada hipótesis sobre tokens de `docs/roadmap.md`: prefijo estable para el caché, assets perezosos, subagentes como frontera de contexto, salidas acotadas.
- **S4** — Registrar la licencia de cada repo (y sus marcas registradas, si las declaran).
- **S5** — Método tomado de la skill reverse-engineer-anything ("Plan broader investigations"): lista de preguntas por repo, ledger de hallazgos que distingue observación, inferencia y desconocido con evidencia `path:line`, búsquedas negativas acotadas declaradas como tales. Las herramientas REA no se usan: la skill indica "Skip REA for ordinary source-repository architecture analysis" y tenemos el código fuente completo.
- **S6** — Cada documento sirve "posteriormente": mapea lo estudiado a las capas 1–9 y a los hitos M1–M6 de `docs/roadmap.md`, con una sección de qué tomar y qué evitar.
- **S7** — Los repos de `repos/` son de solo lectura: el estudio no los modifica.
- **S8** — Idioma de los documentos: español (convención de `docs/`); identificadores, rutas y código quedan tal cual.

## Plantilla de cada documento de repo

1. **Identidad** — repo, commit estudiado (`git log -1`), licencia, marcas, stack, tamaño aproximado.
2. **Mapa** — paquetes/módulos principales y puntos de entrada, con `path:line`.
3. **Preguntas** — la lista de preguntas de la tarea, cada una respondida con evidencia o marcada como desconocida.
4. **Hipótesis de tokens** — veredicto por hipótesis de S3 que aplique al repo (confirmada / descartada / parcial / no aplica), con evidencia.
5. **Qué tomar** — ideas concretas por capa (1–9) e hito (M1–M6).
6. **Qué evitar** — decisiones del repo que no conviene copiar, y por qué.
7. **Ledger** — tabla: hallazgo | tipo (observación / inferencia / desconocido) | evidencia `path:line`.
8. **Preguntas abiertas**.

## Tasks

| ID | Specs | Ruta | Entregable | Commit |
|---|---|---|---|---|
| T1 | S1–S8 | gentle-ai-worker | `docs/m0/pi.md` | sin commit — hecho |
| T2 | S1–S8 | gentle-ai-worker | `docs/m0/gentle-shell.md` | sin commit — hecho |
| T3 | S1–S8 | gentle-ai-worker | `docs/m0/gentle-ai.md` | sin commit — hecho |
| T4 | S1–S8 | gentle-ai-worker | `docs/m0/pi-desktop.md` | sin commit — hecho |
| T5 | S1–S8 | gentle-ai-worker | `docs/m0/gentle-shell-desktop.md` | sin commit — hecho |
| T6 | S1–S8 | gentle-ai-worker | `docs/m0/engram.md` | sin commit — hecho |
| T7 | S1–S6, S8 | inline | `docs/m0/README.md` (síntesis, veredicto de hipótesis, tabla de licencias) y estado de M0 en `docs/roadmap.md` | sin commit — hecho |

### Preguntas por tarea

- **T1 pi** (`repos/pi`): monorepo y rol de cada paquete; `ai`: abstracción de proveedores, streaming, normalización de tool calls, OAuth, prompt caching (dónde se marcan los breakpoints, contabilidad de tokens de caché); `agent`: loop, eventos, cancelación, manejo de errores; `coding-agent`: herramientas (read, edit, bash, grep), permisos, armado del system prompt, formato y almacenamiento de sesiones, compactación, ExtensionAPI, `--mode rpc` y su protocolo; `tui`: cómo renderiza; `codemode`, `mcp`, `durable`: qué son, brevemente.
- **T2 gentle-shell** (`repos/gentle-shell`): cómo extiende pi (extensiones, prompts, assets); armado del prompt y assets perezosos; optimizaciones de tokens y caché (orden del prompt, salidas acotadas, compactación, handoffs); subagentes (`extensions/gentle-agents.ts`); seguimiento ODD (documento de feature, todo, fases); host interactivo (`lib/rpc-host.ts`); integración de memoria; perfiles de modelos.
- **T3 gentle-ai** (`repos/gentle-ai`): qué es y cómo se relaciona con gentle-shell; definición de ODD y RDD; ciclo de review (assess, niveles de riesgo, lentes, consentimiento, recibos, lineage, corrección); `contracts/`; skills; el contrato mirrored que recibe gentle-shell; mediciones de tokens o benchmarks (`bench/`, `results.json`).
- **T4 pi-desktop** (`repos/pi-desktop`): `apps/`, `packages/`, `crates/` y su rol; framework de UI y de escritorio; componentes de mensajes, streaming y render de tool calls; lista de sesiones y layout; manejo de estado; temas; cómo aloja el runtime del agente (la capa de compatibilidad de ExtensionAPI, a evitar); qué ideas de UI reutilizar.
- **T5 gentle-shell-desktop** (`repos/gentle-shell-desktop`): separación main/renderer de Electron; `src/main/domain/session/PiSession.ts`; mensajes del protocolo RPC y del host interactivo; diálogos y pestaña Helpers; manejo de errores (el error de prompt que se pierde); config `home` isolated/link; roadmap propio del repo.
- **T6 engram** (`repos/engram`): solo el contrato: herramientas MCP y sus esquemas, tipos de observación, sesiones, `topic_key`, scopes, búsqueda, transporte (stdio/HTTP/CLI), protocolo de instrucciones que indica al agente cuándo guardar, integración con Pi (`plugin/`), almacenamiento a alto nivel.

## Log

- **L1** — Usuario: "bien, ahora si empecemos con el M0, recopila toda la informacion necesaria y que nos pueda servir posteriormente, apoyate de la skill reverse-engineer-anything"
- **L2** — Decisión: REA no aplica a repos con código fuente completo (lo dice la propia skill); se toma su método de investigación amplia. Seis tareas independientes, una por repo, con superficies de edición disjuntas; síntesis inline.
- **L3** — Primer lanzamiento de workers rechazado por formato de `## Allowed edit surfaces`; relanzado sin cambios de alcance. T1–T6 completados (2 107 líneas en total).
- **L4** — Verificación inline por muestreo: `cache_control` en pi (`anthropic-messages.ts:1233,1529-1550,1659`), error descartado en `rpc-mode.ts:408-412`, reducer que ignora `response` (`chatReducer.ts:73-77`), LGPL-3.0 de pi-desktop, `calculateCacheRate`, 16 `WithDeferLoading` en engram, `lib/child-context-files.ts:2-6`. Todo coincide.
- **L5** — T7 escrito en `docs/m0/README.md`; M0 marcado como hecho en `docs/roadmap.md`. Hallazgo para la decisión de stack: las dos apps de referencia usan Electron + React.
