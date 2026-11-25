// Synthetic sample schema used to exercise the generic canonical-JSON machinery.
// Not a real release-radar file format (those arrive in Phase 2).
import { t } from "../../dist/format.js";

const stage = t.object([
  t.required("name", t.string({ pattern: /^[a-z][a-z0-9-]*$/ })),
  t.optional("owner", t.enum(["dev", "ops"])),
]);

const component = t.object([
  t.required("name", t.string({ minLength: 1 })),
  t.required("image", t.string()),
  t.optional("replicas", t.integer({ positive: true })),
  t.optional("tags", t.array(t.string(), { order: { sorted: "$value" } })),
]);

const check = t.oneOf("kind", {
  http: t.object([
    t.required("kind", t.literal("http")),
    t.required("name", t.string()),
    t.required("url", t.string()),
    t.optional("expectStatus", t.array(t.integer(), { order: "ordered" })),
  ]),
  smoke: t.object([
    t.required("kind", t.literal("smoke")),
    t.required("name", t.string()),
    t.required("argv", t.array(t.string(), { order: "ordered", minItems: 1 })),
  ]),
});

export const fleetSchema = t.object([
  t.required("schemaVersion", t.schemaVersion([1])),
  t.required("name", t.string()),
  t.required("mode", t.enum(["pipeline", "handoff"])),
  t.optional("description", t.nullable(t.string())),
  t.required("stages", t.array(stage, { order: "ordered", identity: "name" })),
  t.required("components", t.array(component, { order: { sorted: "name" }, identity: "name" })),
  t.optional("checks", t.array(check, { order: { sorted: "name" }, identity: "name" })),
  t.required("labels", t.record(t.string(), { keyPattern: /^[a-z][a-z0-9.-]*$/ })),
  t.optional("weight", t.number({ min: 0 })),
  t.optional("enabled", t.boolean()),
]);

/** A file in canonical form. */
export const CANONICAL = `{
  "schemaVersion": 1,
  "name": "acme-fleet",
  "mode": "pipeline",
  "description": null,
  "stages": [
    {
      "name": "stage-2",
      "owner": "dev"
    },
    {
      "name": "stage-1"
    }
  ],
  "components": [
    {
      "name": "acme-api",
      "image": "registry.example.com/acme-api",
      "replicas": 2,
      "tags": [
        "alpha",
        "beta"
      ]
    },
    {
      "name": "acme-web",
      "image": "registry.example.com/acme-web"
    }
  ],
  "checks": [
    {
      "kind": "http",
      "name": "health",
      "url": "https://acme-api.stage-1.example.com/health",
      "expectStatus": [
        204,
        200
      ]
    },
    {
      "kind": "smoke",
      "name": "login",
      "argv": [
        "acme-cli",
        "--flag",
        "--flag"
      ]
    }
  ],
  "labels": {
    "owner": "team-a",
    "tier": "gold"
  },
  "weight": 1.5,
  "enabled": true
}
`;

/**
 * The same semantic content, hand-edited: keys reordered at several levels, odd whitespace,
 * unsorted components/tags/checks/labels, and byte-identical duplicates (a component, a tag,
 * a stage). Ordered arrays (stages, expectStatus, argv) keep their order.
 */
export const HAND_EDITED = `{"name":"acme-fleet",   "schemaVersion":1,
    "mode" : "pipeline",
  "labels": { "tier": "gold", "owner": "team-a" },
"stages": [ {"owner":"dev","name":"stage-2"}, {"name":"stage-1"}, {"name": "stage-1"} ],
  "components": [
    { "name": "acme-web", "image": "registry.example.com/acme-web" },
    { "tags": ["beta", "alpha", "beta"], "replicas": 2, "image": "registry.example.com/acme-api", "name": "acme-api" },
    { "image": "registry.example.com/acme-web", "name": "acme-web" }
  ],
  "checks": [
    {"name": "login", "kind": "smoke", "argv": ["acme-cli", "--flag", "--flag"]},
    {"kind": "http", "url": "https://acme-api.stage-1.example.com/health", "name": "health", "expectStatus": [204, 200]}
  ],
  "description": null, "enabled": true, "weight": 1.5 }`;

/** Exact change summary expected for HAND_EDITED (order: encoding, whitespace, structural pre-order). */
export const HAND_EDITED_CHANGES = [
  "whitespace normalised",
  "keys reordered at (root)",
  "keys reordered at /stages/0",
  "duplicate entry removed at /stages/2 (identical to /stages/1)",
  "keys reordered at /components/1",
  "duplicate entry removed at /components/1/tags/2 (identical to /components/1/tags/0)",
  "array sorted at /components/1/tags",
  "keys reordered at /components/2",
  "duplicate entry removed at /components/2 (identical to /components/0)",
  "array sorted at /components",
  "keys reordered at /checks/0",
  "keys reordered at /checks/1",
  "array sorted at /checks",
  "keys sorted at /labels",
];
