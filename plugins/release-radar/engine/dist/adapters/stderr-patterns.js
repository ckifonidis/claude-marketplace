/**
 * THE stderr-pattern table (spec requirements 21, 29; research `deployment-source-clis.md` §2).
 *
 * One table for every CLI family. Classification is case-insensitive and ordered:
 * auth patterns first, then missing capability, then "not found". Text that matches nothing
 * is `other` and maps to exit 21 — it is NEVER read as "missing" (spec requirement 21).
 *
 * Provenance: every pattern is MODELLED from documented / commonly observed CLI messages, not
 * captured from a live session (research legend [M]). `references/adapters.md` repeats this.
 */
/** The shared, ordered pattern table. Modelled, not captured (see the module comment). */
export const STDERR_PATTERNS = [
    // --- az (App Service, Container Apps) -------------------------------------------------------
    { family: "az", kind: "auth", pattern: /AADSTS\d+/i, meaning: "Microsoft Entra sign-in error (expired / revoked grant, MFA required)" },
    { family: "az", kind: "auth", pattern: /az login/i, meaning: "the CLI asks for `az login`" },
    { family: "az", kind: "auth", pattern: /Interactive authentication is needed/i, meaning: "interactive re-authentication required" },
    { family: "az", kind: "auth", pattern: /refresh token has expired/i, meaning: "refresh token expired" },
    { family: "az", kind: "auth", pattern: /(?:Expired|Invalid)AuthenticationToken/i, meaning: "ARM rejected the access token" },
    { family: "az", kind: "auth", pattern: /AuthorizationFailed|does not have authorization to perform/i, meaning: "the signed-in identity lacks read access" },
    { family: "az", kind: "auth", pattern: /Subscription '[^']*' not found|subscription .* (?:doesn't|does not) exist/i, meaning: "the signed-in account cannot see the configured subscription" },
    { family: "az", kind: "auth", pattern: /No subscription found|No subscriptions found/i, meaning: "the account has no usable subscription" },
    { family: "az", kind: "capability-missing", pattern: /requires the extension containerapp|extension '?containerapp'? is not installed/i, meaning: "the containerapp extension is not installed" },
    { family: "az", kind: "capability-missing", pattern: /'containerapp' is misspelled or not recognized/i, meaning: "this az has no containerapp command group" },
    { family: "az", kind: "not-found", pattern: /ResourceNotFound|ResourceGroupNotFound/i, meaning: "ARM: resource or resource group not found" },
    { family: "az", kind: "not-found", pattern: /could not be found|was not found/i, meaning: "the named resource does not exist" },
    // --- kubectl --------------------------------------------------------------------------------
    { family: "kubectl", kind: "auth", pattern: /You must be logged in to the server/i, meaning: "the cluster rejected the credentials (Unauthorized)" },
    { family: "kubectl", kind: "auth", pattern: /\(Unauthorized\)|error: unauthorized/i, meaning: "Unauthorized" },
    { family: "kubectl", kind: "auth", pattern: /Error from server \(Forbidden\)|\bis forbidden\b/i, meaning: "RBAC forbids the read" },
    { family: "kubectl", kind: "auth", pattern: /context "?[^"\s]*"? (?:does not exist|not found)/i, meaning: "the configured context is not in the kubeconfig" },
    { family: "kubectl", kind: "auth", pattern: /Unable to connect to the server/i, meaning: "the API server is unreachable with this context" },
    { family: "kubectl", kind: "auth", pattern: /the server has asked for the client to provide credentials/i, meaning: "credentials required" },
    { family: "kubectl", kind: "auth", pattern: /getting credentials: exec: |exec plugin/i, meaning: "the kubeconfig credential plugin failed" },
    { family: "kubectl", kind: "not-found", pattern: /Error from server \(NotFound\)/i, meaning: "the workload or namespace does not exist" },
    // --- docker / docker compose ----------------------------------------------------------------
    { family: "docker", kind: "auth", pattern: /Cannot connect to the Docker daemon/i, meaning: "the Docker daemon is not running or not reachable" },
    { family: "docker", kind: "auth", pattern: /error during connect/i, meaning: "the Docker daemon / context endpoint is unreachable" },
    { family: "docker", kind: "auth", pattern: /permission denied while trying to connect to the Docker daemon/i, meaning: "no permission on the Docker socket" },
    { family: "docker", kind: "auth", pattern: /Is the docker daemon running\?/i, meaning: "the Docker daemon is not running" },
    { family: "docker", kind: "capability-missing", pattern: /'compose' is not a docker command|unknown flag: --project-name/i, meaning: "the Compose v2 plugin is not installed" },
    { family: "docker", kind: "not-found", pattern: /Error: No such (?:object|container|image)|No such (?:object|container|image):/i, meaning: "the container or image does not exist" },
];
/**
 * Classifies CLI error text for one family. Rows are tried in table order, auth rows first
 * within the family. The `command` family (and text that matches no row) is `other`.
 */
export function classifyStderr(family, text) {
    if (family === "command" || text.trim() === "")
        return { kind: "other", match: null };
    const order = ["auth", "capability-missing", "not-found"];
    for (const kind of order) {
        for (const row of STDERR_PATTERNS) {
            if (row.family === family && row.kind === kind && row.pattern.test(text))
                return { kind, match: row };
        }
    }
    return { kind: "other", match: null };
}
/** Extracts a tenant id from an az re-login hint (`az login --tenant "<guid>"`), for the printed fix. */
export function tenantHintFrom(text) {
    return /--tenant\s+"?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"?/i.exec(text)?.[1] ?? null;
}
