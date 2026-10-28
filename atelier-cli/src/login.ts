import {
	ANTHROPIC_PROVIDER,
	AuthStore,
	apiKeySource,
	authFile,
	type ClaudeCodeAuthStatus,
	claudeCodeAuthStatus,
	claudeCodeLogin,
	claudeCodeLogout,
	describeClaudeCodeAuth,
	describeError,
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
	/** The platform the Keychain is looked up on; tests pass another so no test asks the real one. */
	platform?: NodeJS.Platform;
	/** Whether a person can answer: signing in with an account and confirming a sign-out need one. */
	interactive: boolean;
	/** The index of the option chosen, or undefined when cancelled. */
	choose(title: string, options: readonly LoginOption[]): Promise<number | undefined>;
	/** A line read without showing it. */
	askSecret(prompt: string): Promise<string | undefined>;
	confirm(question: string): Promise<boolean>;
	/** Runs `task` with the terminal handed to it, for Claude Code's own sign-in. */
	handOver<T>(task: () => Promise<T>): Promise<T>;
	say(text: string): void;
	fail(text: string): void;
}

/**
 * A provider and the backend that uses it. Each method lists its own providers: Codex joins the accounts and
 * OpenCode Go the API keys as one more row each.
 */
interface Provider {
	id: string;
	label: string;
	backend: string;
}

const PROVIDERS: Record<LoginMethod, readonly Provider[]> = {
	account: [{ id: ANTHROPIC_PROVIDER, label: "Anthropic", backend: "claude-code" }],
	"api-key": [{ id: ANTHROPIC_PROVIDER, label: "Anthropic", backend: "anthropic-api" }],
};

const METHODS: readonly { method: LoginMethod; label: string }[] = [
	{ method: "account", label: "Sign in with an account" },
	{ method: "api-key", label: "Sign in with an API key" },
];

export const LOGIN_USAGE = "/login [account|api-key] [anthropic]";
export const LOGOUT_USAGE = "/logout [account|api-key] [anthropic]";

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

async function statusOf(ports: LoginPorts, method: LoginMethod): Promise<string> {
	if (method === "account") {
		const status = await accountStatus(ports);
		if (status instanceof Error) return `unknown: ${status.message}`;
		return status.loggedIn && status.authMethod === "claude.ai"
			? `✓ ${describeClaudeCodeAuth(status)}`
			: describeClaudeCodeAuth(status);
	}
	const stored = store(ports).get(ANTHROPIC_PROVIDER)?.type === "api_key";
	const fromEnv = Boolean(ports.env.ANTHROPIC_API_KEY?.trim());
	if (stored) return fromEnv ? "✓ stored (ANTHROPIC_API_KEY overrides it)" : "✓ stored";
	if (fromEnv) return "from ANTHROPIC_API_KEY";
	return (await apiKeySource({
		store: store(ports),
		env: {},
		...(ports.platform ? { platform: ports.platform } : {}),
	})) === "keychain"
		? "in the Keychain"
		: "not configured";
}

async function pickMethod(ports: LoginPorts, target: LoginTarget): Promise<LoginMethod | undefined> {
	if (target.method !== undefined) return target.method;
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
		providers.map(async ({ label }) => ({ label, status: await statusOf(ports, method) })),
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
	return method === "account" ? loginAccount(ports) : loginApiKey(ports, provider);
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
	if (ports.env.ANTHROPIC_API_KEY?.trim())
		ports.say("ANTHROPIC_API_KEY is set here, and takes priority over the stored key.");
	return true;
}

interface SignedIn extends LoginOption {
	method: LoginMethod;
	provider: string;
}

/** What can be signed out of: each stored key, and Claude Code's login. */
async function signedIn(ports: LoginPorts): Promise<SignedIn[]> {
	const entries: SignedIn[] = [];
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
	if (entry.method === "api-key") {
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
