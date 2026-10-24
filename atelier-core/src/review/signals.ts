/** Added bytes of scanned files past which the content is not trusted to have been read: the level is high. Gentle AI's `processBoundaryScanByteLimit`. */
export const SCAN_LIMIT_BYTES = 8 * 1024 * 1024;

export type ContentSignalKind = "shell_process" | "dangerous_sink";

export interface ContentSignal {
	kind: ContentSignalKind;
	/** Which sink matched; absent for a process. */
	name?: string;
}

/**
 * A process spawn: a bare `exec`/`subprocess`/`child_process` word counts only
 * when it is not a member (`db.exec(`, `/re/.exec(` are not processes), and the
 * spawn calls that exist in member form are named. `spawn(` and `execFile(`
 * are added to gentle-ai's list: a change that only calls an already imported
 * `spawn` has no `child_process` on its added lines.
 */
const PROCESS_SPAWN = new RegExp(
	[
		/(^|[^A-Za-z0-9_.])(subprocess|child_process|execute_process|exec)([^A-Za-z0-9_]|$)/,
		/execSync\s*\(|getRuntime\(\)\.exec\s*\(|ProcessBuilder|os\.system\s*\(|os\.exec[lv]p?e?\s*\(/,
		/posix_spawn|proc_open\s*\(|shell_exec\s*\(|passthru\s*\(|popen\s*\(|Process\.Start\s*\(/,
		/\b(spawn|spawnSync|execFile|execFileSync)\s*\(/,
	]
		.map((pattern) => pattern.source)
		.join("|"),
	"i",
);

/**
 * A member call that spawns a process when its receiver is the process module
 * (`cp.exec(`, `childProcess.spawn(`). The same call is ordinary elsewhere
 * (`/re/.exec(`), so it counts only in a file that imports `child_process`.
 */
const MEMBER_PROCESS_CALL = /\.(exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\s*\(/;

/** Whether a member process call on an added line may count: the caller checks the whole file for the import. */
export function isMemberProcessCall(path: string, text: string): boolean {
	return isScannedPath(path) && !isCommentOnlyLine(path, text) && MEMBER_PROCESS_CALL.test(text);
}

/** Whether a file's text imports the process module, making its member process calls real spawns. */
export function importsProcessModule(text: string): boolean {
	return /child_process/.test(text);
}

const JS = ".js .jsx .ts .tsx .mjs .cjs .mts .cts";
const COMPILED = ".go .java .kt .kts .js .jsx .ts .tsx .mjs .cjs .mts .cts .py .rb .rs .cs";
const SERVER = ".go .js .jsx .ts .tsx .mjs .cjs .mts .cts .py .php .rb .rs .cs";

interface Sink {
	name: string;
	/** Space-separated extensions the sink applies to; empty for any scanned file. */
	extensions: string;
	expression: RegExp;
}

const sink = (name: string, extensions: string, expression: RegExp): Sink => ({ name, extensions, expression });

/** Concrete sinks, not suspicious words, gated by language (gentle-ai's `dangerousSinkCatalog`), plus the destructive commands Atelier already flagged. */
const SINKS: readonly Sink[] = [
	// Disabled certificate validation.
	sink("TLS Go", ".go", /\bInsecureSkipVerify\s*:\s*true\b/),
	sink("TLS JS", JS, /\brejectUnauthorized\s*:\s*false\b|\bNODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0\b/),
	sink("TLS Python", ".py", /\bverify\s*=\s*False\b|\bCERT_NONE\b|\bcheck_hostname\s*=\s*False\b/),
	sink("TLS Rust", ".rs", /\.danger_accept_invalid_certs\s*\(\s*true\s*\)/),
	sink("TLS Ruby", ".rb", /OpenSSL::SSL::VERIFY_NONE\b/),
	sink("TLS PHP", ".php", /\bCURLOPT_SSL_VERIFYPEER\s*=>\s*(?:false|0)\b/),
	sink("TLS C#", ".cs", /ServerCertificateValidationCallback\s*\+=?\s*(?:\([^)]*\)|\w+)\s*=>\s*true\b/),
	sink("TLS shell", ".sh .bash .zsh", /\bcurl\s+(?:[^;|]*\s)?(?:--insecure|-k)(?:\s|$)/),
	sink(
		"TLS Java trust all",
		".java .kt .kts",
		/\bcheckServerTrusted\s*\([^)]*\)\s*\{\s*\}|\bHostnameVerifier\b[^;\n]*\([^)]*\)\s*->\s*true\b/,
	),
	// Deserializing untrusted object graphs.
	sink("pickle", ".py", /\bpickle\.loads?\s*\(/),
	sink("unsafe YAML Python", ".py", /\byaml\.(?:unsafe_load|load)\s*\(/),
	sink("marshal Python", ".py", /\bmarshal\.loads?\s*\(/),
	sink("Java object stream", ".java .kt .kts", /\bObjectInputStream\s*\(/),
	sink("C# formatter", ".cs", /\bBinaryFormatter\s*\(/),
	sink("PHP unserialize", ".php", /(?:^|[^\w.])unserialize\s*\(/),
	sink("Ruby marshal", ".rb", /\bMarshal\.load\s*\(/),
	sink("Ruby YAML", ".rb", /\bYAML\.load\s*\(/),
	sink("C# type names", ".cs", /\bTypeNameHandling\s*(?:=|:)\s*TypeNameHandling\.(?:All|Auto)\b/),
	sink("node serialize", JS, /\b(?:serialize|nodeSerialize)\.unserialize\s*\(/),
	// Runtime evaluation of supplied code.
	sink("eval", `${JS} .py .php .rb`, /(?:^|[^\w.])eval\s*\(/),
	sink("Function constructor", JS, /\bnew\s+Function\s*\(/),
	sink("node VM", JS, /\bvm\.runInNewContext\s*\(/),
	sink("PHP create_function", ".php", /\bcreate_function\s*\(/),
	sink("Ruby string eval", ".rb", /\b(?:instance_eval|class_eval)\s*\(\s*["'`]/),
	// Shell interpretation of composed commands.
	sink(
		"Python shell",
		".py",
		/\bsubprocess\.(?:run|Popen|call|check_call|check_output)\s*\(\s*(?:[A-Za-z_]\w*|f["']|["'][^"']*["']\s*\+)[^;\n]*\bshell\s*=\s*True\b/,
	),
	sink(
		"Python system composition",
		".py",
		/\bos\.system\s*\(\s*(?:f["']|[^)\n]*(?:\+\s*[A-Za-z_]\w*|[A-Za-z_]\w*\s*\+|%\s*[A-Za-z_]\w*|\.format\s*\(\s*[A-Za-z_]\w*))/,
	),
	sink("PHP shell variable", ".php", /\b(?:system|exec|shell_exec|passthru)\s*\(\s*\$\w+|`[^`]*\$\w+[^`]*`/),
	sink("Ruby interpolated shell", ".rb", /`[^`]*#\{[^}]+\}[^`]*`|%x[({][^)}]*#\{[^}]+\}/),
	sink("composed sh -c", COMPILED, /["'](?:sh|bash)["']\s*,\s*["']-c["']\s*,\s*(?:\w+|["'][^"']*["']\s*\+|f["']|`)/),
	// A weak digest of a credential, not a file checksum.
	sink(
		"weak credential hash",
		`${COMPILED} .php`,
		/\b(?:hashlib\.)?(?:md5|sha1)(?:\.Sum)?\s*\(\s*\$?\w*(?:password|passwd|secret|token)\w*\b|\bcreateHash\s*\(\s*['"](?:md5|sha1)['"]\s*\)\s*\.update\s*\(\s*\w*(?:password|passwd|secret|token)\w*\b|\bMessageDigest\.getInstance\s*\(\s*['"](?:MD5|SHA-1)['"]\s*\)\.digest\s*\(\s*\w*(?:password|passwd|secret|token)\w*\b/i,
	),
	// Wildcard origin with credential sharing on one line.
	sink(
		"credentialed wildcard CORS",
		`${COMPILED} .php`,
		/Access-Control-Allow-Origin[^;\n]*\*[^;\n]*;[^\n]*Access-Control-Allow-Credentials[^\n]*true/i,
	),
	// World-writable modes.
	sink(
		"world writable API",
		SERVER,
		/\b(?:chmod|mkdir|writefile)\s*\([^\n]*\b(?:0o777|0777|0666)\b|\bumask\s*\(\s*0\s*\)/i,
	),
	sink("world writable shell", ".sh .bash .zsh", /\bchmod\s+(?:-R\s+)?(?:777\b|o\+w\b)/),
	// Decoded tokens that are not verified signatures.
	sink(
		"JWT Python bypass",
		".py",
		/\bjwt\.decode\s*\([^\n]*(?:\bverify\s*=\s*False\b|["']verify_signature["']\s*:\s*False\b|\balgorithms\s*=\s*\[\s*["']none["']\s*\])/,
	),
	sink("JWT Go unverified", ".go", /\b(?:jwt|\w+)\.ParseUnverified\s*\(/),
	sink("JWT Java unsecured", ".java .kt .kts", /\.parseUnsecuredClaims\s*\(/),
	// Explicit CSRF opt-outs.
	sink("CSRF Python", ".py", /@csrf_exempt\b|\bWTF_CSRF_ENABLED\s*=\s*False\b/),
	sink("CSRF Spring", ".java .kt .kts", /\.csrf\s*\(\s*\)\.disable\s*\(/),
	sink("CSRF Rails", ".rb", /\bskip_before_action\s+:verify_authenticity_token\b/),
	sink("CSRF config", `${JS} .php .rb`, /\bcsrf\s*:\s*false\b|\bcsrf\s*=>\s*false\b/),
	sink("CSRF C#", ".cs", /\[IgnoreAntiforgeryToken\]/),
	// External entities and DTD expansion.
	sink("XXE Python", ".py", /\bresolve_entities\s*=\s*True\b/),
	sink(
		"XXE Java",
		".java .kt .kts",
		/\bXMLInputFactory\.IS_SUPPORTING_EXTERNAL_ENTITIES\s*,\s*true\b|\.setExpandEntityReferences\s*\(\s*true\s*\)/,
	),
	sink("XXE PHP", ".php", /\bLIBXML_NOENT\b/),
	sink("XXE C#", ".cs", /\bDtdProcessing\.Parse\b/),
	// Destructive commands, in any scanned file.
	sink("rm -rf", "", /\brm\s+-(?=[a-z]*r)(?=[a-z]*f)[a-z]+\b/i),
	sink("DROP TABLE", "", /\bdrop\s+table\b/i),
	sink("DELETE FROM", "", /\bdelete\s+from\b/i),
];

/** A python `yaml.load` is unsafe unless its own call names a SafeLoader. */
function hasUnsafeYamlLoad(line: string): boolean {
	if (line.includes("yaml.unsafe_load(")) return true;
	for (const call of line.matchAll(/\byaml\.load\s*\(/g)) {
		const start = call.index + call[0].length;
		let depth = 1;
		let end = line.length;
		for (let i = start; i < line.length; i++) {
			if (line[i] === "(") depth++;
			else if (line[i] === ")" && --depth === 0) {
				end = i;
				break;
			}
		}
		if (!/\bLoader\s*=\s*(?:yaml\.)?C?SafeLoader\b/.test(line.slice(start, end))) return true;
	}
	return false;
}

/** The signals of one added line; none for a test file, a file whose bytes are not scanned, or a line that is only a comment in its language. */
export function contentSignals(
	path: string,
	text: string,
	{ processModule = false }: { processModule?: boolean } = {},
): ContentSignal[] {
	if (!isScannedPath(path) || isCommentOnlyLine(path, text)) return [];
	const found: ContentSignal[] = [];
	if (PROCESS_SPAWN.test(text) || (processModule && MEMBER_PROCESS_CALL.test(text)))
		found.push({ kind: "shell_process" });
	const extension = extensionOf(path);
	for (const entry of SINKS) {
		if (entry.extensions !== "" && !` ${entry.extensions} `.includes(` ${extension} `)) continue;
		if (!entry.expression.test(text)) continue;
		if (entry.name === "unsafe YAML Python" && !hasUnsafeYamlLoad(text)) continue;
		found.push({ kind: "dangerous_sink", name: entry.name });
		break;
	}
	return found;
}

const SOURCE_EXTENSIONS = new Set(
	`.c .cc .cpp .cs .go .h .hpp .java .js .jsx .kt .kts .php .py .rb .rs .sh .bash .zsh .ts .tsx .mjs .cjs .mts .cts .sql`.split(
		" ",
	),
);
const CONFIG_NAMES = new Set(["go.mod", "go.sum", "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"]);
const CONFIG_EXTENSIONS = new Set([".json", ".yaml", ".yml", ".toml", ".ini", ".env"]);

/** Source, configuration and text files that are not tests, fixtures or documentation folders: the files whose added bytes are scanned. */
export function isScannedPath(path: string): boolean {
	if (isTestPath(path)) return false;
	const segments = path.toLowerCase().split("/");
	if (segments.some((segment) => ["docs", "testdata", "fixture", "fixtures", "__fixtures__"].includes(segment)))
		return false;
	const name = segments[segments.length - 1] ?? "";
	const extension = extensionOf(path);
	return (
		SOURCE_EXTENSIONS.has(extension) ||
		extension === ".txt" ||
		CONFIG_EXTENSIONS.has(extension) ||
		CONFIG_NAMES.has(name) ||
		name === "dockerfile" ||
		name === "makefile" ||
		name === ".env" ||
		name.startsWith(".env.")
	);
}

/** A test file by its own name or a folder that only holds tests: production folders also use `test/` and `spec/`, so those names alone are not evidence. */
export function isTestPath(path: string): boolean {
	const segments = path.toLowerCase().split("/");
	const name = segments.pop() ?? "";
	return (
		segments.some((segment) => segment === "__tests__" || segment === "testdata") ||
		name.includes(".test.") ||
		name.includes(".spec.") ||
		name.endsWith("_test.go") ||
		name.endsWith("_test.py") ||
		(name.startsWith("test_") && name.endsWith(".py"))
	);
}

function extensionOf(path: string): string {
	const name = (path.split("/").pop() ?? path).toLowerCase();
	const dot = name.lastIndexOf(".");
	return dot <= 0 ? "" : name.slice(dot);
}

type CommentSyntax = "hash" | "dash" | "slash" | "unknown";

const HASH_NAMES = /^(dockerfile|makefile|cmakelists\.txt|\.env(\..*)?|requirements.*\.txt)$/;
const HASH_EXTENSIONS =
	".sh .bash .zsh .py .rb .pl .pm .r .ps1 .psm1 .yaml .yml .toml .ini .conf .cfg .cmake .mk .tf .nix";
const DASH_EXTENSIONS = ".sql .lua .hs .adb .ads";
const SLASH_EXTENSIONS = `.c .cc .cpp .h .hpp .cs .go .java ${JS} .kt .kts .php .rs .swift .scala .dart`;

function commentSyntaxOf(path: string): CommentSyntax {
	const name = (path.split("/").pop() ?? path).toLowerCase();
	const extension = extensionOf(path);
	if (HASH_NAMES.test(name) || ` ${HASH_EXTENSIONS} `.includes(` ${extension} `)) return "hash";
	if (extension !== "" && ` ${DASH_EXTENSIONS} `.includes(` ${extension} `)) return "dash";
	if (extension !== "" && ` ${SLASH_EXTENSIONS} `.includes(` ${extension} `)) return "slash";
	return "unknown";
}

/**
 * An added line that is only a comment in the language of its file. A marker
 * counts only where the language uses it (`#` opens a C directive and a
 * TypeScript private field), and code after a closed block comment is code. An
 * unknown language is never skipped, so the scan fails toward high.
 */
export function isCommentOnlyLine(path: string, line: string): boolean {
	const trimmed = line.trim();
	switch (commentSyntaxOf(path)) {
		case "hash":
			return trimmed.startsWith("#");
		case "dash":
			return trimmed.startsWith("--");
		case "slash": {
			if (trimmed.startsWith("//")) return true;
			if (trimmed.startsWith("/*")) {
				const closing = trimmed.indexOf("*/", 2);
				return closing < 0 || trimmed.slice(closing + 2).trim() === "";
			}
			if (trimmed.startsWith("*/")) return trimmed.slice(2).trim() === "";
			// A block comment continuation is a lone `*` followed by whitespace or nothing; `*cmd` is a dereference.
			return trimmed === "*" || trimmed.startsWith("* ") || trimmed.startsWith("*\t");
		}
		default:
			return false;
	}
}

/**
 * An added line that opens a block comment it does not close, in a language
 * with `/* */ ` comments. Only a line that starts with the opener counts: a
 * `; /*` inside a string must not hide the lines after it.
 */
export function opensBlockComment(path: string, line: string): boolean {
	if (commentSyntaxOf(path) !== "slash") return false;
	const trimmed = line.trim();
	return trimmed.startsWith("/*") && !trimmed.includes("*/", 2);
}

/** Files that can be passive: Markdown and text anywhere, and documentation formats or extensionless files under docs/. */
export function isDocumentationPath(path: string): boolean {
	if (/\.(md|txt)$/i.test(path)) return true;
	if (!(path.startsWith("docs/") || path.includes("/docs/"))) return false;
	const name = path.split("/").pop() ?? path;
	return /\.(md|mdx|txt|rst|adoc)$/i.test(name) || !name.includes(".");
}

/**
 * Whether a nominated documentation file is inert by its own bytes. The
 * extension only nominates: an interpreter line, text that is not valid UTF-8,
 * a script tag or MDX that can run code withdraws it.
 */
export function isPassiveDocumentContent(path: string, text: string): boolean {
	if (text.includes("\0") || text.includes("\uFFFD")) return false;
	if (text.replace(/^\uFEFF/, "").startsWith("#!")) return false;
	if (/<script\b/i.test(text)) return false;
	return path.toLowerCase().endsWith(".mdx") ? isStaticMdx(text) : true;
}

/** MDX with no import, export, expression or tag outside code fences and inline code. */
function isStaticMdx(text: string): boolean {
	let fence = "";
	for (const raw of text.split("\n")) {
		const trimmed = raw.replace(/^\uFEFF/, "").trim();
		if (fence !== "") {
			if (trimmed.startsWith(fence)) fence = "";
			continue;
		}
		const opening = /^(```|~~~)/.exec(trimmed);
		if (opening) {
			fence = opening[1] as string;
			continue;
		}
		const prose = trimmed.replace(/`+[^`]*`+/g, "");
		if (/^(import|export)\b/.test(prose) || /[{}<]/.test(prose)) return false;
	}
	return true;
}

/** A Markdown code fence line: ``` or ~~~, indented or not. */
export const FENCE = /^[ \t]*(```|~~~)/m;
