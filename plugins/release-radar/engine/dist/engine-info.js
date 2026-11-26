/**
 * Where the engine lives and which version it is, derived ONLY from this module's own location
 * (`import.meta.url`); no environment variable is read (plan decisions D11, D21: the plugin-root
 * variables are not set in the Bash environment).
 *
 * Layout: `<plugin root>/engine/dist/engine-info.js`, `<plugin root>/engine/VERSION`.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT, EngineError } from "./errors.js";
const DIST_DIR = dirname(fileURLToPath(import.meta.url));
/** Absolute `<plugin root>/engine`. */
export function engineRoot() {
    return resolve(DIST_DIR, "..");
}
/** Absolute plugin root (the directory holding `.claude-plugin/` and `skills/`). */
export function pluginRoot() {
    return resolve(DIST_DIR, "..", "..");
}
let cachedVersion;
/**
 * The engine version from `engine/VERSION` (one line, semver).
 * @throws EngineError 1 when the file is missing or malformed (a broken install, not configuration).
 */
export function engineVersion() {
    if (cachedVersion !== undefined)
        return cachedVersion;
    const file = resolve(engineRoot(), "VERSION");
    let text;
    try {
        text = readFileSync(file, "utf8");
    }
    catch (error) {
        throw new EngineError(EXIT.INTERNAL, "internal", `engine VERSION file unreadable: ${file} (${error.message})`);
    }
    const version = text.trim();
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
        throw new EngineError(EXIT.INTERNAL, "internal", `engine VERSION file is not a version: ${file}`);
    }
    cachedVersion = version;
    return version;
}
