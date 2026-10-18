import pkg from "./package.json" with { type: "json" };

declare const DOPPIO_COMMIT: string | undefined;

export const version: string = pkg.version;
export const commit = typeof DOPPIO_COMMIT === "string" && DOPPIO_COMMIT ? DOPPIO_COMMIT : undefined;
export const versionLabel = `doppio ${version}${commit ? ` (${commit})` : ""}`;
