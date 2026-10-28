import { ModelData } from "./model-data.ts";

let current = new ModelData();

/**
 * The catalog the process looks models up in when the code's tables lack them: prices, levels and windows. A process
 * has one, empty until a catalog is loaded; pure, so the desktop renderer can import the tables that read it.
 */
export function currentModelData(): ModelData {
	return current;
}

/** Replaces the catalog, as a refresh lands; requests already sent keep what they were sent with. */
export function useModelData(data: ModelData): void {
	current = data;
}
