import type { AtelierBridge } from "../../shared/bridge.ts";

declare global {
	interface Window {
		atelier: AtelierBridge;
	}
}
