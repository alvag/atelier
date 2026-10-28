import {
	ANTHROPIC_PROVIDER,
	AuthStore,
	apiKeySource,
	authFile,
	CHATGPT_PROVIDER,
	type ClaudeCodeAuthStatus,
	CODEX_PROVIDER,
	type Credential,
	claudeCodeAuthStatus,
	claudeCodeLogin,
	claudeCodeLogout,
	describeClaudeCodeAuth,
	describeError,
	loginChatGpt,
	loginCodex,
	type OAuthInteraction,
	OPENCODE_GO_KEY_ENV,
	OPENCODE_GO_PROVIDER,
	openInBrowser,
	type SecurityRunner,
} from "@atelier/core";

/** How to sign in: with an account in the browser, or with an API key. */
export type LoginMethod = "account" | "api-key";

/** What `/login` and `atelier login` were given; what is missing is asked. */
export interface LoginTarget {
	method?: LoginMethod;
	provider?: string;
}

/** One line of a list to choose from: what it is and its state. */
export interface LoginOption {
	label: string;
	status?: string;
}

/** What a sign-in needs from the client that runs it: the CLI on a terminal, the line-by-line session or the TUI. */
export interface LoginPorts {
	home: string;
	env: Record<string, string | undefined>;
	/** The Claude Code binary; the one Atelier installs when absent. Tests pass a fake. */
	claudeCode?: string;
	/** The platform the Keychain is looked up on, and what asks it; tests pass a fake so no test asks the real one. */
	platform?: NodeJS.Platform;
	runSecurity?: SecurityRunner;
	/** Whether a person can answer: signing in with an account and confirming a sign-out need one. */
	interactive: boolean;
	/** The index of the option chosen, or undefined when cancelled. */
	choose(title: string, options: readonly LoginOption[]): Promise<number | undefined>;
	/** A line read without showing it. */
	askSecret(prompt: string): Promise<string | undefined>;
	/**
	 * A line that `signal` stops waiting for (the browser answered first); undefined when cancelled or stopped. `hint`
	 * replaces the TUI's line under the question.
	 */
	askUntil(prompt: string, signal: AbortSignal, hint?: string): Promise<string | undefined>;
	/** Opens a sign-in page; the system's browser when absent. */
	openBrowser?: (url: string) => Promise<void>;
	/** Where the OpenAI sign-ins go, for tests: a fake auth server and a free port instead of 1455. */
	openai?: { authUrl?: string; callbackPort?: number; minPollIntervalMs?: number };
	confirm(question: string): Promise<boolean>;
	/** Runs `task` with the terminal handed to it, for Claude Code's own sign-in. */
	handOver<T>(task: () => Promise<T>): Promise<T>;
	say(text: string): void;
	fail(text: string): void;
}

/** What the OpenAI sign-ins take from the caller: tests pass a fake browser and auth server. */
export type OpenAiLoginHooks = Pick<LoginPorts, "openBrowser" | "openai">;

/**
 * A provider and the backend that uses it. Each method lists its own providers. An API key names the variable that
 * overrides the stored one, and whether the Keychain may hold it.
 */
interface Provider {
	id: string;
	label: string;
	backend: string;
	env?: string;
	keychain?: boolean;
	/** How `/logout` names what it removes. */
	signedInLabel?: string;
}

const CODEX: Provider = {
	id: CODEX_PROVIDER,
	label: "OpenAI Codex (ChatGPT Plus/Pro)",
	backend: "openai-codex",
	signedInLabel: "OpenAI Codex sign-in",
};
const CHATGPT: Provider = {
	id: CHATGPT_PROVIDER,
	label: "Sign in with ChatGPT",
	backend: "openai-codex",
	signedInLabel: "Sign in with ChatGPT",
};
/** The accounts Atelier signs in to itself and keeps in `auth.json`; Anthropic's is Claude Code's own. */
const OPENAI_ACCOUNTS: readonly Provider[] = [CODEX, CHATGPT];

const PROVIDERS: Record<LoginMethod, readonly Provider[]> = {
	account: [{ id: ANTHROPIC_PROVIDER, label: "Anthropic", backend: "claude-code" }, ...OPENAI_ACCOUNTS],
	"api-key": [
		{ id: ANTHROPIC_PROVIDER, label: "Anthropic", backend: "anthropic-api", env: "ANTHROPIC_API_KEY", keychain: true },
		{ id: OPENCODE_GO_PROVIDER, label: "OpenCode Go", backend: "opencode-go", env: OPENCODE_GO_KEY_ENV },
	],
};

const METHODS: readonly { method: LoginMethod; label: string }[] = [
	{ method: "account", label: "Sign in with an account" },
	{ method: "api-key", label: "Sign in with an API key" },
];

export const LOGIN_USAGE = "/login [account|api-key] [anthropic|opencode-go|openai-codex|openai-chatgpt]";
export const LOGOUT_USAGE = "/logout [account|api-key] [anthropic|opencode-go|openai-codex|openai-chatgpt]";

/** `[account|api-key] [provider]`, either word optional; undefined for anything else. */
export function parseLoginTarget(words: readonly string[]): LoginTarget | undefined {
	const [first, ...others] = words;
	const method = first === "account" || first === "api-key" ? first : undefined;
	const [provider, ...extra] = method === undefined ? words : others;
	if (extra.length > 0) return undefined;
	return {
		...(method === undefined ? {} : { method }),
		...(provider === undefined ? {} : { provider }),
	};
}

const store = (ports: LoginPorts) => new AuthStore(authFile(ports.home));
const runOptions = (ports: LoginPorts) => ({
	env: ports.env,
	...(ports.claudeCode === undefined ? {} : { executable: ports.claudeCode }),
});

/** Claude Code's login, or the reason it could not be read. */
async function accountStatus(ports: LoginPorts): Promise<ClaudeCodeAuthStatus | Error> {
	try {
		return await claudeCodeAuthStatus(runOptions(ports));
	} catch (error) {
		return error as Error;
	}
}

const isOpenAiAccount = (provider: Provider) => OPENAI_ACCOUNTS.some(({ id }) => id === provider.id);
const signedInTo = (ports: LoginPorts, provider: Provider) => store(ports).get(provider.id)?.type === "oauth";

async function statusOf(ports: LoginPorts, method: LoginMethod, provider: Provider): Promise<string> {
	if (method === "account" && isOpenAiAccount(provider))
		return signedInTo(ports, provider) ? "✓ signed in" : "not signed in";
	if (method === "account") {
		const status = await accountStatus(ports);
		if (status instanceof Error) return `unknown: ${status.message}`;
		return status.loggedIn && status.authMethod === "claude.ai"
			? `✓ ${describeClaudeCodeAuth(status)}`
			: describeClaudeCodeAuth(status);
	}
	const stored = store(ports).get(provider.id)?.type === "api_key";
	const fromEnv = provider.env !== undefined && Boolean(ports.env[provider.env]?.trim());
	if (stored) return fromEnv ? `✓ stored (${provider.env} overrides it)` : "✓ stored";
	if (fromEnv) return `from ${provider.env}`;
	if (!provider.keychain) return "not configured";
	return (await apiKeySource({
		store: store(ports),
		env: {},
		...(ports.platform ? { platform: ports.platform } : {}),
		...(ports.runSecurity ? { runSecurity: ports.runSecurity } : {}),
	})) === "keychain"
		? "in the Keychain"
		: "not configured";
}

async function pickMethod(ports: LoginPorts, target: LoginTarget): Promise<LoginMethod | undefined> {
	if (target.method !== undefined) return target.method;
	// A provider that only one method has needs no question.
	const withProvider = METHODS.filter(({ method }) => PROVIDERS[method].some(({ id }) => id === target.provider));
	if (withProvider.length === 1) return withProvider[0]?.method;
	const index = await ports.choose(
		"Select authentication method",
		METHODS.map(({ label }) => ({ label })),
	);
	return index === undefined ? undefined : METHODS[index]?.method;
}

async function pickProvider(
	ports: LoginPorts,
	method: LoginMethod,
	target: LoginTarget,
): Promise<Provider | undefined> {
	const providers = PROVIDERS[method];
	if (target.provider !== undefined) {
		const found = providers.find((provider) => provider.id === target.provider);
		if (found === undefined)
			ports.fail(
				`unknown provider "${target.provider}" for ${method === "account" ? "an account" : "an API key"}; the providers are: ${providers.map(({ id }) => id).join(", ")}`,
			);
		return found;
	}
	const options = await Promise.all(
		providers.map(async (provider) => ({ label: provider.label, status: await statusOf(ports, method, provider) })),
	);
	const index = await ports.choose(METHODS.find((entry) => entry.method === method)?.label ?? method, options);
	return index === undefined ? undefined : providers[index];
}

/** `/login` and `atelier login`: asks what is missing, signs in, and says whether it worked. */
export async function login(ports: LoginPorts, target: LoginTarget = {}): Promise<boolean> {
	const method = await pickMethod(ports, target);
	const provider = method === undefined ? undefined : await pickProvider(ports, method, target);
	if (method === undefined || provider === undefined) {
		if (target.provider === undefined) ports.say("Nothing changed.");
		return false;
	}
	if (method === "api-key") return loginApiKey(ports, provider);
	return isOpenAiAccount(provider) ? loginOpenAi(ports, provider) : loginAccount(ports);
}

/** No browser to open here: a session over SSH, or Linux without a display. */
function headless(ports: LoginPorts): boolean {
	if (ports.env.SSH_CONNECTION || ports.env.SSH_TTY) return true;
	return (ports.platform ?? process.platform) === "linux" && !ports.env.DISPLAY && !ports.env.WAYLAND_DISPLAY;
}

const CODEX_TERMS =
	"OpenAI Codex uses the Codex CLI's own sign-in, on ChatGPT's Codex endpoint: OpenAI may refuse it at any time, and using it from another program may go against its terms. Sign in with ChatGPT (/login account openai-chatgpt) is the way OpenAI offers other agents. Either counts against your ChatGPT plan's limits.";

/** Signs in to ChatGPT for the openai-codex backend and keeps the tokens in `auth.json`. */
async function loginOpenAi(ports: LoginPorts, provider: Provider): Promise<boolean> {
	if (!ports.interactive) {
		ports.fail("signing in with an account needs a terminal: run atelier login in one");
		return false;
	}
	const noBrowser = headless(ports);
	const interaction: OAuthInteraction = {
		openBrowser: noBrowser
			? async () => {}
			: (url) => (ports.openBrowser ?? ((page: string) => openInBrowser(new URL(page))))(url),
		show: (text) => ports.say(text),
		// An empty line cancels, as Esc does in the TUI.
		askPasted: async (prompt, signal) => (await ports.askUntil(`${prompt}: `, signal))?.trim() || undefined,
		// Any answer cancels: there is nothing to type while the code is entered elsewhere.
		waitOrCancel: async (prompt, signal) => {
			await ports.askUntil(`${prompt} (Enter cancels): `, signal, "Enter the code on the other device · Esc cancels");
		},
	};
	const settings = ports.openai ?? {};
	let credential: Credential;
	try {
		if (provider.id === CODEX_PROVIDER) {
			ports.say(CODEX_TERMS);
			const ways = [
				{ method: "browser" as const, label: "In the browser" },
				{ method: "device" as const, label: "With a device code" },
			];
			if (noBrowser) ways.reverse();
			const index = await ports.choose("How to sign in to OpenAI Codex", ways);
			const way = index === undefined ? undefined : ways[index];
			if (way === undefined) {
				ports.say("Nothing changed.");
				return false;
			}
			credential = await loginCodex(interaction, { method: way.method, ...settings });
		} else {
			if (noBrowser) ports.say("No browser here: open the URL below on any device, then paste the URL it ends on.");
			const { minPollIntervalMs: _unused, ...chatgpt } = settings;
			credential = await loginChatGpt(interaction, { home: ports.home, ...chatgpt });
		}
		await store(ports).set(provider.id, credential);
	} catch (error) {
		ports.fail(describeError(error));
		return false;
	}
	ports.say(
		`✓ ${provider.signedInLabel === CODEX.signedInLabel ? "OpenAI Codex" : provider.label}: signed in, stored in ~/.atelier/auth.json; --backend ${provider.backend} uses it.`,
	);
	return true;
}

async function loginAccount(ports: LoginPorts): Promise<boolean> {
	if (!ports.interactive) {
		ports.fail("signing in with an account needs a terminal: run atelier login in one");
		return false;
	}
	ports.say(
		"Anthropic: Claude Code opens the browser to sign in to your Claude account; finish there, or paste the code it shows.",
	);
	try {
		const code = await ports.handOver(() => claudeCodeLogin(runOptions(ports)));
		const status = await claudeCodeAuthStatus(runOptions(ports));
		if (status.loggedIn && status.authMethod === "claude.ai") {
			ports.say(`✓ Anthropic: ${describeClaudeCodeAuth(status)}. The claude-code backend uses it.`);
			return true;
		}
		ports.fail(
			status.loggedIn
				? `Claude Code is logged in, but not with a Claude subscription: ${describeClaudeCodeAuth(status)}`
				: `Claude Code is still not logged in (its sign-in exited with ${code})`,
		);
	} catch (error) {
		ports.fail(describeError(error));
	}
	return false;
}

async function loginApiKey(ports: LoginPorts, provider: Provider): Promise<boolean> {
	const key = (await ports.askSecret(`${provider.label} API key (hidden): `))?.trim();
	if (!key) {
		ports.fail("no key given; nothing changed");
		return false;
	}
	try {
		await store(ports).set(provider.id, { type: "api_key", key });
	} catch (error) {
		ports.fail(describeError(error));
		return false;
	}
	ports.say(`✓ ${provider.label}: API key stored in ~/.atelier/auth.json; --backend ${provider.backend} uses it.`);
	if (provider.env !== undefined && ports.env[provider.env]?.trim())
		ports.say(`${provider.env} is set here, and takes priority over the stored key.`);
	return true;
}

interface SignedIn extends LoginOption {
	method: LoginMethod;
	provider: string;
}

/** What can be signed out of: each stored key, and Claude Code's login. */
async function signedIn(ports: LoginPorts): Promise<SignedIn[]> {
	const entries: SignedIn[] = [];
	for (const provider of OPENAI_ACCOUNTS)
		if (signedInTo(ports, provider))
			entries.push({
				method: "account",
				provider: provider.id,
				label: provider.signedInLabel ?? provider.label,
				status: "✓ signed in",
			});
	for (const provider of PROVIDERS["api-key"])
		if (store(ports).get(provider.id) !== undefined)
			entries.push({
				method: "api-key",
				provider: provider.id,
				label: `${provider.label} API key`,
				status: "✓ stored",
			});
	const status = await accountStatus(ports);
	if (!(status instanceof Error) && status.loggedIn)
		entries.push({
			method: "account",
			provider: ANTHROPIC_PROVIDER,
			label: "Anthropic account (Claude Code)",
			status: describeClaudeCodeAuth(status),
		});
	return entries;
}

/** `/logout` and `atelier logout`: lists what has a credential and removes the one chosen. */
export async function logout(ports: LoginPorts, target: LoginTarget = {}): Promise<boolean> {
	const known = (
		target.method === undefined ? [...PROVIDERS.account, ...PROVIDERS["api-key"]] : PROVIDERS[target.method]
	).map(({ id }) => id);
	if (target.provider !== undefined && !known.includes(target.provider)) {
		const kind = target.method === undefined ? "" : target.method === "account" ? " for an account" : " for an API key";
		ports.fail(`unknown provider "${target.provider}"${kind}; the providers are: ${[...new Set(known)].join(", ")}`);
		return false;
	}
	const entries = (await signedIn(ports)).filter(
		(entry) =>
			(target.method === undefined || entry.method === target.method) &&
			(target.provider === undefined || entry.provider === target.provider),
	);
	if (entries.length === 0) {
		ports.say("Nothing to sign out of.");
		return true;
	}
	const index = entries.length === 1 ? 0 : await ports.choose("Select what to sign out of", entries);
	const entry = index === undefined ? undefined : entries[index];
	if (entry === undefined) {
		ports.say("Nothing changed.");
		return false;
	}
	if (entry.method === "api-key" || entry.provider !== ANTHROPIC_PROVIDER) {
		await store(ports).remove(entry.provider);
		ports.say(`${entry.label} removed from ~/.atelier/auth.json.`);
		return true;
	}
	return logoutAccount(ports);
}

async function logoutAccount(ports: LoginPorts): Promise<boolean> {
	if (!ports.interactive) {
		ports.fail("signing out of an account needs a terminal to confirm it: run atelier logout in one");
		return false;
	}
	const sure = await ports.confirm(
		"Signing out of Anthropic signs out Claude Code on this machine too: the claude command and anything else that uses its login. Sign out?",
	);
	if (!sure) {
		ports.say("Nothing changed.");
		return false;
	}
	try {
		await ports.handOver(() => claudeCodeLogout(runOptions(ports)));
		const status = await claudeCodeAuthStatus(runOptions(ports));
		if (!status.loggedIn) {
			ports.say("Signed out of Claude Code.");
			return true;
		}
		ports.fail(`Claude Code is still logged in: ${describeClaudeCodeAuth(status)}`);
	} catch (error) {
		ports.fail(describeError(error));
	}
	return false;
}
