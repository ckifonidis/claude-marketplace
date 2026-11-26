/**
 * `azure-appservice` adapter (spec requirement 24): a parity port of the original engine.
 *
 * Calls (read-only):
 * - preflight: `az account show --output json` (cached sign-in; the first list proves validity);
 * - read: `az webapp list --subscription <id> --query <projection> --output json`, ONCE per
 *   subscription per read (deduplicated across stages and targets);
 * - only when a listed app's `linuxFxVersion` is null (not populated by the list):
 *   `az webapp config show --resource-group <rg> --name <app> --subscription <id> --query linuxFxVersion --output json`
 *   for that single target.
 *
 * Target handling (parity): names match case-insensitively within the stage's subscriptions;
 * a requested name present in two subscriptions of one stage is refused (exit 21, the report
 * would be ambiguous); a stopped app keeps its image and reports its state; a non-container
 * app (runtime stack, blank) is flagged, not reported as an image; `COMPOSE|`/`KUBE|` are
 * multi-container and `SITECONTAINERS` is the sidecar model (image undetermined in v1).
 * `lastModifiedTimeUtc` moves on any site change: an upper bound, never a deploy time.
 */

import type { Workspace } from "../config.js";
import { EXIT, EngineError } from "../errors.js";
import { parseLinuxFxVersion, type ImageInfo } from "../image.js";
import { AZ_HINTS, azAccountShow, azJson } from "./az.js";
import {
  SourceError,
  isRecord,
  missingReading,
  renderCommand,
  stringField,
  toIsoUtc,
  type Adapter,
  type AdapterRuntime,
  type ContainerReading,
  type DiscoverCandidate,
  type PreflightResult,
  type TargetOf,
  type TargetReading,
  type TargetRequest,
} from "./types.js";

/** The workspace's `adapters.azure-appservice` block. */
export type AppServiceSettings = NonNullable<Workspace["adapters"]["azure-appservice"]>;

/** The JMESPath projection sent with every `az webapp list` (parity with the original engine, plus `kind`). */
export const WEBAPP_LIST_QUERY =
  "[].{name:name,resourceGroup:resourceGroup,state:state,kind:kind," +
  "linuxFxVersion:siteConfig.linuxFxVersion,lastModifiedTimeUtc:lastModifiedTimeUtc}";

/** One web app as listed. `linuxFxVersion: null` means the list did not populate it. */
export interface WebappRecord {
  readonly name: string;
  readonly resourceGroup: string;
  readonly subscription: string;
  readonly state: string | null;
  readonly kind: string | null;
  readonly linuxFxVersion: string | null;
  readonly lastModifiedTimeUtc: string | null;
}

type Request = TargetRequest<TargetOf<"azure-appservice">>;

function timeoutMs(settings: AppServiceSettings): number {
  return settings.timeoutSeconds * 1000;
}

function subscriptionsFor(settings: AppServiceSettings, stage: string): readonly string[] {
  const subscriptions = settings.stageSubscriptions[stage];
  if (subscriptions === undefined || subscriptions.length === 0) {
    throw new EngineError(EXIT.INVALID, "validate", `adapters.azure-appservice.stageSubscriptions has no entry for stage "${stage}"`);
  }
  return subscriptions;
}

/** Lists every web app of one subscription in ONE call. */
export async function listWebapps(subscription: string, settings: AppServiceSettings, runtime: AdapterRuntime): Promise<WebappRecord[]> {
  const args = ["webapp", "list", "--subscription", subscription, "--query", WEBAPP_LIST_QUERY];
  const result = await azJson(args, timeoutMs(settings), runtime.env);
  if (result.kind === "not-found") {
    throw new SourceError("az", `\`${renderCommand("az", args)}\` reported the subscription's resources as not found: ${result.stderr.trim().split("\n")[0] ?? ""}`);
  }
  if (!Array.isArray(result.value)) throw new SourceError("az", `\`az webapp list --subscription ${subscription}\` did not return a JSON array`);
  const records: WebappRecord[] = [];
  for (const item of result.value) {
    if (!isRecord(item)) continue;
    const name = stringField(item, "name");
    if (name === null || name === "") continue;
    const fx = item["linuxFxVersion"];
    records.push({
      name,
      resourceGroup: stringField(item, "resourceGroup") ?? "",
      subscription,
      state: stringField(item, "state"),
      kind: stringField(item, "kind"),
      linuxFxVersion: typeof fx === "string" ? fx : null,
      lastModifiedTimeUtc: stringField(item, "lastModifiedTimeUtc"),
    });
  }
  return records;
}

/** Reads one app's `linuxFxVersion` through `az webapp config show` (only used when the list left it null). */
async function configShowLinuxFx(record: WebappRecord, settings: AppServiceSettings, runtime: AdapterRuntime): Promise<string | null> {
  const args = [
    "webapp", "config", "show",
    "--resource-group", record.resourceGroup,
    "--name", record.name,
    "--subscription", record.subscription,
    "--query", "linuxFxVersion",
  ];
  const result = await azJson(args, timeoutMs(settings), runtime.env);
  if (result.kind === "not-found") return null;
  return typeof result.value === "string" ? result.value : null;
}

function imageNotes(image: ImageInfo, fx: string): string[] {
  switch (image.kind) {
    case "image":
      return [];
    case "non-container":
      return [`not container-configured (linuxFxVersion ${JSON.stringify(fx)})`];
    case "multi-container":
      return [`multi-container configuration (${fx.split("|")[0] ?? ""}|…) — no single image`];
    case "sidecar":
      return ["sidecar model (SITECONTAINERS) — the main container's image is not read in this version"];
    case "invalid":
      return [`unparseable linuxFxVersion ${JSON.stringify(fx)}: ${image.reason}`];
  }
}

/** Builds the reading for a found web app. */
export function appServiceReading(request: Request, record: WebappRecord, fx: string, fxSource: "list" | "config show"): TargetReading {
  const image = parseLinuxFxVersion(fx);
  const notes = imageNotes(image, fx);
  if (record.state !== null && record.state.toLowerCase() !== "running") {
    notes.push(`state ${record.state} — the configured image is not serving`);
  }
  const lastModified = toIsoUtc(record.lastModifiedTimeUtc, "utc");
  if (lastModified === null) notes.push("no last-modified time exposed");
  const containers: ContainerReading[] =
    image.kind === "image" ? [{ name: null, image, source: `webapp ${record.name}`, digest: null, imageId: null, trafficWeight: null }] : [];
  return {
    key: request.key,
    stage: request.stage,
    target: request.target.name,
    adapter: "azure-appservice",
    status: "found",
    image,
    containers,
    state: record.state,
    lastModified,
    lastModifiedSource: lastModified === null ? null : "lastModifiedTimeUtc",
    digest: null,
    imageId: null,
    digestStatus: "not-exposed",
    mixed: false,
    rollout: null,
    details: {
      subscription: record.subscription,
      resourceGroup: record.resourceGroup,
      kind: record.kind,
      linuxFxVersionSource: fxSource,
    },
    notes,
  };
}

/** Creates the `azure-appservice` adapter. */
export function createAzureAppServiceAdapter(settings: AppServiceSettings, runtime: AdapterRuntime): Adapter<"azure-appservice"> {
  return {
    name: "azure-appservice",
    async preflight(requests): Promise<PreflightResult> {
      for (const request of requests) subscriptionsFor(settings, request.stage);
      const account = await azAccountShow(timeoutMs(settings), runtime.env);
      return { adapter: "azure-appservice", commands: [account.command], identity: account.identity };
    },
    async read(requests): Promise<TargetReading[]> {
      const lists = new Map<string, WebappRecord[]>();
      const listFor = async (subscription: string) => {
        const cached = lists.get(subscription);
        if (cached !== undefined) return cached;
        const records = await listWebapps(subscription, settings, runtime);
        lists.set(subscription, records);
        return records;
      };
      const readings: TargetReading[] = [];
      for (const request of requests) {
        const subscriptions = subscriptionsFor(settings, request.stage);
        const wanted = request.target.webapp.toLowerCase();
        const matches: WebappRecord[] = [];
        for (const subscription of subscriptions) {
          for (const record of await listFor(subscription)) if (record.name.toLowerCase() === wanted) matches.push(record);
        }
        const distinct = [...new Set(matches.map((m) => m.subscription))];
        if (distinct.length > 1) {
          throw new SourceError(
            "az",
            `webapp "${request.target.webapp}" exists in BOTH ${distinct.join(" and ")} (stage "${request.stage}") — the report would be ambiguous`,
          );
        }
        const record = matches[0];
        if (record === undefined) {
          readings.push(
            missingReading(request, `webapp "${request.target.webapp}" not found in subscription(s) ${subscriptions.join(", ")} of stage "${request.stage}"`),
          );
          continue;
        }
        if (record.linuxFxVersion === null) {
          const fx = await configShowLinuxFx(record, settings, runtime);
          readings.push(appServiceReading(request, record, fx ?? "", "config show"));
        } else {
          readings.push(appServiceReading(request, record, record.linuxFxVersion, "list"));
        }
      }
      return readings;
    },
  };
}

/**
 * Lists the web apps each stage's subscriptions can see (one list per subscription), as
 * `discover` candidates sorted by stage then name. A name present in two subscriptions of one
 * stage is listed twice with `details.ambiguous: true`. No name is inferred or grouped.
 */
export async function discoverAzureAppService(
  settings: AppServiceSettings,
  runtime: AdapterRuntime,
  stages: readonly string[],
): Promise<DiscoverCandidate[]> {
  const candidates: DiscoverCandidate[] = [];
  const lists = new Map<string, WebappRecord[]>();
  for (const stage of stages) {
    const records: WebappRecord[] = [];
    for (const subscription of subscriptionsFor(settings, stage)) {
      let list = lists.get(subscription);
      if (list === undefined) {
        list = await listWebapps(subscription, settings, runtime);
        lists.set(subscription, list);
      }
      records.push(...list);
    }
    const counts = new Map<string, Set<string>>();
    for (const r of records) counts.set(r.name.toLowerCase(), (counts.get(r.name.toLowerCase()) ?? new Set()).add(r.subscription));
    records
      .slice()
      .sort((a, b) => (a.name === b.name ? a.subscription.localeCompare(b.subscription) : a.name.localeCompare(b.name)))
      .forEach((record) =>
        candidates.push({
          adapter: "azure-appservice",
          stage,
          fields: { webapp: record.name },
          image: record.linuxFxVersion,
          state: record.state,
          details: {
            subscription: record.subscription,
            resourceGroup: record.resourceGroup,
            kind: record.kind,
            ambiguous: (counts.get(record.name.toLowerCase())?.size ?? 0) > 1,
          },
        }),
      );
  }
  return candidates;
}

/** Re-exported for the adapter docs: the hints printed on auth / install failures. */
export const APP_SERVICE_HINTS = AZ_HINTS;
