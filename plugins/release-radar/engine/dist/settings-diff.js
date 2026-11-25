/**
 * Key-level settings-file comparison (spec requirements 56, 64, 73; plan Phase 8).
 *
 * Compares one settings file between the commit a stage currently runs (the DEPLOYED side) and
 * the commit being promoted (the PROMOTED side) and reports, per file:
 * - file added (absent at the deployed commit) / removed (absent at the promoted commit) / absent
 *   on both sides;
 * - for JSON files: added keys, removed keys, probable renames and keys whose value changed —
 *   every key as an RFC 6901 JSON pointer, NEVER a value;
 * - added / removed / renamed secret-reference NAMES (the {@link SECRET_REFERENCE_DETECTORS});
 * - a file that does not parse as strict JSON: its line count per side only ("unparseable").
 *
 * ## Values never leave this module
 * Values are only ever hashed (sha256 over the canonical JSON of the value) and compared in
 * memory. No value, no hash, and no parser message (which could quote content) appears in any
 * result. The only strings taken from a file's content are secret-reference NAMES (requirement 56
 * asks for them) — never the surrounding value.
 *
 * ## Structure
 * Objects are walked key by key; every non-object value — scalars, arrays, and empty objects — is
 * one LEAF identified by its pointer. Arrays are compared whole (an element change reports the
 * array's key as changed), so index shifts never produce spurious added/removed keys. Secret
 * references are searched in EVERY string, array elements included.
 *
 * ## Probable renames
 * A removed key and an added key are paired as a probable rename when their value hashes are
 * identical AND that hash occurs on exactly one removed and exactly one added key (an ambiguous
 * hash pairs nothing). A rename is evidence, not proof; the pair leaves the added/removed lists.
 *
 * A secret-reference rename is a pointer present on both sides whose value is a reference on both
 * sides, where the deployed name is no longer referenced anywhere in the promoted file and the
 * promoted name was not referenced anywhere in the deployed file.
 */
import { createHash } from "node:crypto";
import { canonicalStringify, parseJsonStrict, t } from "./format.js";
import { childPointer } from "./pointer.js";
const KEY_VAULT_HOST = String.raw `([A-Za-z0-9-]{3,24})\.vault\.(?:azure\.net|azure\.cn|usgovcloudapi\.net|microsoftazure\.de)`;
function keyVaultReferenceName(body) {
    const params = new Map();
    for (const part of body.split(";")) {
        const index = part.indexOf("=");
        if (index > 0)
            params.set(part.slice(0, index).trim().toLowerCase(), part.slice(index + 1).trim());
    }
    const uri = params.get("secreturi");
    if (uri !== undefined) {
        const match = new RegExp(String.raw `^https://${KEY_VAULT_HOST}/secrets/([A-Za-z0-9-]{1,127})(?:/[A-Za-z0-9]*)?/?$`, "i").exec(uri);
        return match === null ? null : `${match[1].toLowerCase()}/${match[2]}`;
    }
    const vault = params.get("vaultname");
    const secret = params.get("secretname");
    if (vault !== undefined && secret !== undefined && /^[A-Za-z0-9-]{1,127}$/.test(vault) && /^[A-Za-z0-9-]{1,127}$/.test(secret)) {
        return `${vault.toLowerCase()}/${secret}`;
    }
    return null;
}
/**
 * The generic secret-reference detector set (spec requirement 56). A string may hold several
 * references; each is reported as `<detector id>:<name>`. Names are compared exactly (vault host
 * names are lower-cased, as DNS is case-insensitive).
 */
export const SECRET_REFERENCE_DETECTORS = [
    {
        id: "azure-keyvault",
        description: "Azure Key Vault reference `@Microsoft.KeyVault(SecretUri=https://<vault>.vault.azure.net/secrets/<name>[/<version>])` or `@Microsoft.KeyVault(VaultName=<vault>;SecretName=<name>[;SecretVersion=<v>])` → `<vault>/<name>`",
        pattern: /@Microsoft\.KeyVault\(([^)]*)\)/gi,
        name: (match) => keyVaultReferenceName(match[1]),
    },
    {
        id: "azure-keyvault-uri",
        description: "a bare Key Vault secret URI `https://<vault>.vault.azure.net/secrets/<name>[/<version>]` (e.g. an App Configuration Key Vault reference) → `<vault>/<name>`",
        pattern: new RegExp(String.raw `https://${KEY_VAULT_HOST}/secrets/([A-Za-z0-9-]{1,127})`, "gi"),
        name: (match) => `${match[1].toLowerCase()}/${match[2]}`,
    },
    {
        id: "ci-secret",
        description: "a CI secret expression `${{ secrets.<NAME> }}` → `<NAME>`",
        pattern: /\$\{\{\s*secrets\.([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/g,
        name: (match) => match[1],
    },
    {
        id: "aws-secretsmanager",
        description: "an AWS dynamic reference `{{resolve:secretsmanager:<id>[:…]}}` or a secret ARN `arn:aws:secretsmanager:<region>:<account>:secret:<name>` → `<id>` / `<name>`",
        pattern: /\{\{resolve:secretsmanager:([A-Za-z0-9/_+=.@-]+)[^}]*\}\}|arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:\d{12}:secret:([A-Za-z0-9/_+=.@-]+)/g,
        name: (match) => (match[1] ?? match[2]),
    },
    {
        id: "aws-ssm-secure",
        description: "an AWS SecureString dynamic reference `{{resolve:ssm-secure:<name>[:<version>]}}` → `<name>`",
        pattern: /\{\{resolve:ssm-secure:([A-Za-z0-9/_.-]+)(?::\d+)?\}\}/g,
        name: (match) => match[1],
    },
    {
        id: "gcp-secretmanager",
        description: "a Google Secret Manager resource `projects/<project>/secrets/<name>[/versions/<v>]` or `sm://<project>/<name>` → `<project>/<name>`",
        pattern: /(?:^|[^A-Za-z0-9/])projects\/([a-z0-9-]{1,63})\/secrets\/([A-Za-z0-9_-]{1,255})|sm:\/\/([a-z0-9-]{1,63})\/([A-Za-z0-9_-]{1,255})/g,
        name: (match) => (match[1] !== undefined ? `${match[1]}/${match[2]}` : `${match[3]}/${match[4]}`),
    },
    {
        id: "hashicorp-vault",
        description: "a HashiCorp Vault injector reference `vault:<path>#<key>` → `<path>#<key>`",
        pattern: /(?:^|[^A-Za-z0-9])vault:([A-Za-z0-9_./-]+)#([A-Za-z0-9_.-]+)/g,
        name: (match) => `${match[1]}#${match[2]}`,
    },
];
/**
 * Every secret-reference name in `value`, sorted, without duplicates. Detectors run in the
 * documented order and each match is masked before the next detector runs, so one reference is
 * never reported twice (e.g. the URI inside a `@Microsoft.KeyVault(SecretUri=…)` reference).
 */
export function secretReferenceNames(value) {
    const names = new Set();
    let remaining = value;
    for (const detector of SECRET_REFERENCE_DETECTORS) {
        const pattern = new RegExp(detector.pattern.source, detector.pattern.flags);
        const spans = [];
        for (let match = pattern.exec(remaining); match !== null; match = pattern.exec(remaining)) {
            if (match[0] === "") {
                pattern.lastIndex++;
                continue;
            }
            const name = detector.name(match);
            if (name !== null)
                names.add(`${detector.id}:${name}`);
            spans.push([match.index, match.index + match[0].length]);
        }
        for (const [start, end] of spans)
            remaining = remaining.slice(0, start) + " ".repeat(end - start) + remaining.slice(end);
    }
    return [...names].sort();
}
/** True when `value` contains anything that looks like a secret reference, recognised or not. */
function looksLikeReference(value) {
    return secretReferenceNames(value).length > 0 || /@Microsoft\.KeyVault\(/i.test(value);
}
// ---------------------------------------------------------------------------
// Literal-secret heuristic
/** Whole-value placeholder shapes: substituted at deploy time, never a literal secret. */
const PLACEHOLDERS = [
    /^\s*$/,
    /^\$\{[^}]*\}$/, // ${NAME}
    /^\$\([^)]*\)$/, // $(NAME)
    /^#\{[^}]*\}#?$/, // #{NAME}# token replacement
    /^\{\{[^}]*\}\}$/, // {{NAME}}
    /^__[A-Za-z0-9_.-]+__$/, // __NAME__
    /^<[^<>]+>$/, // <your-password>
    /^%[A-Za-z0-9_]+%$/, // %NAME%
    /^@@[A-Za-z0-9_.-]+@@$/, // @@NAME@@
    /^[*xX•._-]+$/, // masked
];
function isPlaceholder(value) {
    return PLACEHOLDERS.some((pattern) => pattern.test(value.trim()));
}
/** Last word of a secret-bearing key name (`dbPassword`, `CLIENT_SECRET`, `api-key`, …). */
const SECRET_LAST_WORDS = new Set([
    "password",
    "passwords",
    "passwd",
    "pwd",
    "passphrase",
    "secret",
    "secrets",
    "token",
    "tokens",
    "credential",
    "credentials",
    "apikey",
    "apikeys",
    "connectionstring",
]);
/** Last two words of a secret-bearing key name, joined. */
const SECRET_LAST_TWO = new Set([
    "apikey",
    "accesskey",
    "accountkey",
    "secretkey",
    "privatekey",
    "signingkey",
    "encryptionkey",
    "masterkey",
    "sharedkey",
    "subscriptionkey",
    "connectionstring",
    "clientsecret",
    "sastoken",
]);
/** Last three words of a secret-bearing key name, joined. */
const SECRET_LAST_THREE = new Set(["sharedaccesskey", "sharedaccesssignature"]);
/** Splits a key name into lower-case words at camelCase boundaries and `_ - . : space`. */
export function keyWords(key) {
    return key
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .split(/[\s_.:-]+/)
        .filter((word) => word !== "")
        .map((word) => word.toLowerCase());
}
/** True when the key's NAME says it holds a credential (judged on its last word(s) only). */
export function isSecretKeyName(key) {
    const words = keyWords(key);
    const last = (count) => (words.length >= count ? words.slice(-count).join("") : null);
    const one = last(1);
    const two = last(2);
    const three = last(3);
    return (one !== null && SECRET_LAST_WORDS.has(one)) || (two !== null && SECRET_LAST_TWO.has(two)) || (three !== null && SECRET_LAST_THREE.has(three));
}
/** `Key=Value;Key=Value` (a connection string): judged by its credential parameters only. */
const CONNECTION_STRING = /^\s*[^=;]+=[^;]*(?:;\s*[^=;]+=[^;]*)*;?\s*$/;
/** True when a connection string carries a non-placeholder credential parameter. */
function connectionStringHasLiteralCredential(value) {
    const pattern = /(?:^|;)\s*(?:password|pwd|accountkey|sharedaccesskey|sharedsecret)\s*=\s*([^;]*)/gi;
    for (let match = pattern.exec(value); match !== null; match = pattern.exec(value)) {
        if (!isPlaceholder(match[1]))
            return true;
    }
    return false;
}
/** Value shapes that are credentials whatever the key is called. */
function credentialShaped(value) {
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value))
        return true;
    if (/^eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(value.trim()))
        return true;
    const userinfo = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:([^/\s@]+)@/i.exec(value.trim());
    if (userinfo !== null && !isPlaceholder(userinfo[1]))
        return true;
    return connectionStringHasLiteralCredential(value);
}
/**
 * The literal-secret heuristic (spec requirement 64 step 4): a string value is warned about —
 * BY KEY POINTER ONLY — when it is not a secret reference and not a placeholder, and either
 * (a) its key name ends in a credential word ({@link isSecretKeyName}) and the value is not a
 * `Key=Value;…` connection string, or (b) the value itself has a credential shape (a PEM private
 * key, a JWT, a URL with a password, or a connection string with a non-placeholder `Password` /
 * `Pwd` / `AccountKey` / `SharedAccessKey` / `SharedSecret` parameter).
 * Non-string values are never warned about. Returns the pointers, sorted.
 */
export function literalSecretPointers(value) {
    const found = new Set();
    const walk = (node, pointer, key) => {
        if (typeof node === "string") {
            if (looksLikeReference(node) || isPlaceholder(node))
                return;
            // A connection string is judged by its credential parameters, whatever its key is called.
            const secretName = key !== null && isSecretKeyName(key) && !CONNECTION_STRING.test(node);
            if (secretName || credentialShaped(node))
                found.add(pointer);
            return;
        }
        if (Array.isArray(node)) {
            node.forEach((item, index) => walk(item, childPointer(pointer, index), key));
            return;
        }
        if (node !== null && typeof node === "object") {
            for (const [child, item] of Object.entries(node))
                walk(item, childPointer(pointer, child), child);
        }
    };
    walk(value, "", null);
    return [...found].sort();
}
/** Number of lines of `bytes` (a final line without a newline counts). */
export function lineCount(bytes) {
    if (bytes.length === 0)
        return 0;
    let count = 0;
    for (const byte of bytes)
        if (byte === 0x0a)
            count++;
    return bytes[bytes.length - 1] === 0x0a ? count : count + 1;
}
function hashValue(value) {
    return createHash("sha256").update(canonicalStringify(value), "utf8").digest("hex");
}
function flatten(value, pointer, leaves, references) {
    collectReferences(value, pointer, references);
    const walk = (node, at) => {
        if (node !== null && typeof node === "object" && !Array.isArray(node) && Object.keys(node).length > 0) {
            for (const [key, item] of Object.entries(node))
                walk(item, childPointer(at, key));
            return;
        }
        leaves.set(at, hashValue(node));
    };
    walk(value, pointer);
}
function collectReferences(node, pointer, references) {
    if (typeof node === "string") {
        const names = secretReferenceNames(node);
        if (names.length > 0)
            references.set(pointer, names);
    }
    else if (Array.isArray(node)) {
        node.forEach((item, index) => collectReferences(item, childPointer(pointer, index), references));
    }
    else if (node !== null && typeof node === "object") {
        for (const [key, item] of Object.entries(node))
            collectReferences(item, childPointer(pointer, key), references);
    }
}
/**
 * Analyses one side: `null` bytes = the file does not exist at that commit. A file that is not
 * strict JSON (comments, trailing commas, YAML, `.env`, …) is `unparseable`: only its line count is
 * kept — the parser's message is discarded because it could quote content.
 */
export function analyzeSettings(bytes) {
    if (bytes === null)
        return { parse: "absent", lines: null, leaves: new Map(), references: new Map(), literalSecrets: [] };
    let value;
    try {
        value = parseJsonStrict(bytes.toString("utf8"), "settings");
    }
    catch {
        return { parse: "unparseable", lines: lineCount(bytes), leaves: new Map(), references: new Map(), literalSecrets: [] };
    }
    const leaves = new Map();
    const references = new Map();
    flatten(value, "", leaves, references);
    return { parse: "json", lines: lineCount(bytes), leaves, references, literalSecrets: literalSecretPointers(value) };
}
// ---------------------------------------------------------------------------
// The diff
const POINTER = t.string();
const RENAME = t.object([t.required("from", POINTER), t.required("to", POINTER)]);
const SIDE_PARSE = t.enum(["json", "unparseable", "absent"]);
const LINES = t.nullable(t.integer({ min: 0 }));
/**
 * Schema of one file's diff (embedded in the handoff manifest's `settingsDiff`). Canonical key
 * order:
 * ```
 * path                      as declared (relative to the component root)
 * status                    unchanged | changed | added | removed | absent | unparseable
 * parse { deployed, promoted }   json | unparseable | absent
 * lines { deployed, promoted }   line count, or null when absent
 * addedKeys[]    SORTED     JSON pointers present only on the promoted side
 * removedKeys[]  SORTED     JSON pointers present only on the deployed side
 * changedKeys[]  SORTED     JSON pointers on both sides whose value differs (no value shown)
 * renamedKeys[]  SORTED by from   { from, to } probable renames
 * secretReferences
 *   added[]   SORTED        names referenced only on the promoted side
 *   removed[] SORTED        names referenced only on the deployed side
 *   renamed[] SORTED by pointer   { pointer, from, to }
 * ```
 */
export const SETTINGS_FILE_DIFF_SCHEMA = t.object([
    t.required("path", t.string({ minLength: 1 })),
    t.required("status", t.enum(["unchanged", "changed", "added", "removed", "absent", "unparseable"])),
    t.required("parse", t.object([t.required("deployed", SIDE_PARSE), t.required("promoted", SIDE_PARSE)])),
    t.required("lines", t.object([t.required("deployed", LINES), t.required("promoted", LINES)])),
    t.required("addedKeys", t.array(POINTER, { order: { sorted: "$value" } })),
    t.required("removedKeys", t.array(POINTER, { order: { sorted: "$value" } })),
    t.required("changedKeys", t.array(POINTER, { order: { sorted: "$value" } })),
    t.required("renamedKeys", t.array(RENAME, { order: { sorted: "from" }, identity: "from" })),
    t.required("secretReferences", t.object([
        t.required("added", t.array(t.string({ minLength: 1 }), { order: { sorted: "$value" } })),
        t.required("removed", t.array(t.string({ minLength: 1 }), { order: { sorted: "$value" } })),
        t.required("renamed", t.array(t.object([t.required("pointer", POINTER), t.required("from", t.string({ minLength: 1 })), t.required("to", t.string({ minLength: 1 }))]), {
            order: { sorted: "pointer" },
            identity: "pointer",
        })),
    ])),
]);
function sorted(values, key) {
    return [...values].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}
function allNames(side) {
    const names = new Set();
    for (const list of side.references.values())
        for (const name of list)
            names.add(name);
    return names;
}
/**
 * Diffs one settings file between the deployed side and the promoted side. Absent sides compare
 * as empty, so an added JSON file lists every key as added (and a removed one as removed).
 */
export function diffSettingsFile(path, deployed, promoted) {
    const status = deployed.parse === "absent" && promoted.parse === "absent"
        ? "absent"
        : deployed.parse === "absent"
            ? "added"
            : promoted.parse === "absent"
                ? "removed"
                : deployed.parse === "unparseable" || promoted.parse === "unparseable"
                    ? "unparseable"
                    : "changed";
    const addedKeys = [];
    const removedKeys = [];
    const changedKeys = [];
    for (const [pointer, hash] of promoted.leaves) {
        const before = deployed.leaves.get(pointer);
        if (before === undefined)
            addedKeys.push(pointer);
        else if (before !== hash)
            changedKeys.push(pointer);
    }
    for (const pointer of deployed.leaves.keys())
        if (!promoted.leaves.has(pointer))
            removedKeys.push(pointer);
    // Probable renames: a value hash held by exactly one removed and exactly one added key.
    const byHash = (keys, side) => {
        const map = new Map();
        for (const key of keys) {
            const hash = side.leaves.get(key);
            map.set(hash, [...(map.get(hash) ?? []), key]);
        }
        return map;
    };
    const removedByHash = byHash(removedKeys, deployed);
    const addedByHash = byHash(addedKeys, promoted);
    const renamedKeys = [];
    for (const [hash, removed] of removedByHash) {
        const added = addedByHash.get(hash);
        if (removed.length === 1 && added !== undefined && added.length === 1)
            renamedKeys.push({ from: removed[0], to: added[0] });
    }
    const renamedFrom = new Set(renamedKeys.map((rename) => rename.from));
    const renamedTo = new Set(renamedKeys.map((rename) => rename.to));
    // Secret-reference names.
    const deployedNames = allNames(deployed);
    const promotedNames = allNames(promoted);
    const renamedReferences = [];
    for (const [pointer, before] of deployed.references) {
        const after = promoted.references.get(pointer);
        if (after === undefined || before.length !== 1 || after.length !== 1)
            continue;
        const from = before[0];
        const to = after[0];
        if (from !== to && !promotedNames.has(from) && !deployedNames.has(to))
            renamedReferences.push({ pointer, from, to });
    }
    const renamedReferenceFrom = new Set(renamedReferences.map((rename) => rename.from));
    const renamedReferenceTo = new Set(renamedReferences.map((rename) => rename.to));
    const diff = {
        path,
        status,
        parse: { deployed: deployed.parse, promoted: promoted.parse },
        lines: { deployed: deployed.lines, promoted: promoted.lines },
        addedKeys: addedKeys.filter((key) => !renamedTo.has(key)).sort(),
        removedKeys: removedKeys.filter((key) => !renamedFrom.has(key)).sort(),
        changedKeys: changedKeys.sort(),
        renamedKeys: sorted(renamedKeys, (rename) => rename.from),
        secretReferences: {
            added: [...promotedNames].filter((name) => !deployedNames.has(name) && !renamedReferenceTo.has(name)).sort(),
            removed: [...deployedNames].filter((name) => !promotedNames.has(name) && !renamedReferenceFrom.has(name)).sort(),
            renamed: sorted(renamedReferences, (rename) => rename.pointer),
        },
    };
    if (status === "changed") {
        const nothing = diff.addedKeys.length + diff.removedKeys.length + diff.changedKeys.length + diff.renamedKeys.length + diff.secretReferences.added.length + diff.secretReferences.removed.length + diff.secretReferences.renamed.length === 0;
        if (nothing)
            return { ...diff, status: "unchanged" };
    }
    return diff;
}
/** Human lines for one file's diff (names and pointers only). */
export function renderSettingsFileDiff(diff, indent) {
    const at = (pointer) => (pointer === "" ? "(root)" : pointer);
    const lines = [];
    const head = {
        unchanged: "unchanged (no key-level difference)",
        changed: "changed",
        added: "file ADDED (absent at the deployed commit)",
        removed: "file REMOVED (absent at the promoted commit)",
        absent: "absent at both commits",
        unparseable: "unparseable (not strict JSON) — line counts only",
    };
    lines.push(`${indent}${diff.path}: ${head[diff.status]}`);
    const sub = `${indent}  `;
    if (diff.status === "unparseable" || diff.parse.deployed === "unparseable" || diff.parse.promoted === "unparseable") {
        const count = (parse, value) => (parse === "absent" ? "absent" : `${value ?? 0} lines${parse === "unparseable" ? ", unparseable" : ""}`);
        lines.push(`${sub}deployed: ${count(diff.parse.deployed, diff.lines.deployed)}; promoted: ${count(diff.parse.promoted, diff.lines.promoted)}`);
    }
    for (const key of diff.addedKeys)
        lines.push(`${sub}+ key ${at(key)}`);
    for (const key of diff.removedKeys)
        lines.push(`${sub}- key ${at(key)}`);
    for (const rename of diff.renamedKeys)
        lines.push(`${sub}~ probable rename ${at(rename.from)} → ${at(rename.to)} (same value)`);
    for (const key of diff.changedKeys)
        lines.push(`${sub}* value changed at ${at(key)} (value not shown)`);
    for (const name of diff.secretReferences.added)
        lines.push(`${sub}+ secret reference ${name}`);
    for (const name of diff.secretReferences.removed)
        lines.push(`${sub}- secret reference ${name}`);
    for (const rename of diff.secretReferences.renamed)
        lines.push(`${sub}~ secret reference at ${at(rename.pointer)}: ${rename.from} → ${rename.to}`);
    return lines;
}
