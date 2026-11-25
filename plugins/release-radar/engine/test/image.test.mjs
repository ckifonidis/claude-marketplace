// Image-reference parsing (spec requirements 23-28, 52; D16).
// Part 1: the edge-case table of release-radar-docs/research/image-reference-parsing.md §4.
// Part 2: the original engine's nine linuxFxVersion behaviours, re-expressed synthetically.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isComparableDigest, parseImage, parseLinuxFxVersion, sameBuild } from "../dist/image.js";

const HEX64 = "a".repeat(64);
const HEX64B = "b".repeat(64);

function image(input, options) {
  const parsed = parseImage(input, options);
  assert.equal(parsed.kind, "image", `${JSON.stringify(input)} → ${JSON.stringify(parsed)}`);
  return parsed;
}

function invalid(input, reason) {
  const parsed = parseImage(input);
  assert.equal(parsed.kind, "invalid", `${JSON.stringify(input)} → ${JSON.stringify(parsed)}`);
  if (reason) assert.match(parsed.reason, reason);
}

// --- research edge-case table -----------------------------------------------------------------

test("#1 DOCKER| prefix with registry, nested repo and tag", () => {
  const i = image("DOCKER|registry.example.com/acme/api:1.2.3");
  assert.deepEqual([i.registry, i.repository, i.tag, i.implicitRegistry, i.implicitTag], ["registry.example.com", "acme/api", "1.2.3", false, false]);
});

test("#2-#3 a registry port is not a tag; a missing tag is implicit latest", () => {
  assert.equal(image("registry.example.com:5000/acme/api:1.2.3").registry, "registry.example.com:5000");
  const implicit = image("registry.example.com:5000/acme/api");
  assert.deepEqual([implicit.tag, implicit.implicitTag, implicit.digest], ["latest", true, null]);
});

test("#4-#5 localhost is a registry with or without a port", () => {
  assert.equal(image("localhost:5000/app").registry, "localhost:5000");
  const local = image("localhost/app:2");
  assert.deepEqual([local.registry, local.repository, local.tag], ["localhost", "app", "2"]);
});

test("#6 app:5000 is a Docker Hub repository with tag 5000", () => {
  const i = image("app:5000");
  assert.deepEqual([i.registry, i.repository, i.tag, i.implicitRegistry], ["docker.io", "library/app", "5000", true]);
});

test("#7-#8 Docker Hub namespaces and single names", () => {
  const ns = image("acme/api");
  assert.deepEqual([ns.registry, ns.implicitRegistry, ns.repository, ns.tag], ["docker.io", true, "acme/api", "latest"]);
  assert.equal(image("nginx").repository, "library/nginx");
});

test("#9-#10 digests: tag + digest keeps both; digest only has tag null", () => {
  const both = image(`acme/api:1.0@sha256:${HEX64}`);
  assert.deepEqual([both.tag, both.digest, both.implicitTag], ["1.0", `sha256:${HEX64}`, false]);
  const only = image(`acme/api@sha256:${HEX64}`);
  assert.deepEqual([only.tag, only.digest, only.implicitTag], [null, `sha256:${HEX64}`, false]);
});

test("#11 a deeply nested repository survives", () => {
  assert.equal(image("registry.example.com/a/b/c/d:1").repository, "a/b/c/d");
});

test("#12 a bracketed IPv6 registry with a port", () => {
  const i = image("[::1]:5000/app:1");
  assert.deepEqual([i.registry, i.repository, i.tag], ["[::1]:5000", "app", "1"]);
});

test("#13 an uppercase first segment is a registry host, lower-cased", () => {
  assert.equal(image("Registry.Example.com/app").registry, "registry.example.com");
});

test("#14 uppercase repository: nonCanonical when lenient, invalid when strict", () => {
  assert.equal(image("registry.example.com/Acme/Api").nonCanonical, true);
  assert.equal(parseImage("registry.example.com/Acme/Api", { strictCase: true }).kind, "invalid");
  assert.equal(image("registry.example.com/acme/api").nonCanonical, false);
});

test("#15 Docker Hub aliases normalise to docker.io", () => {
  assert.equal(image("index.docker.io/acme/api").registry, "docker.io");
  assert.equal(image("docker.io/acme/api").registry, "docker.io");
  assert.equal(image("registry-1.docker.io/acme/api").registry, "docker.io");
});

test("#16 a registry without a repository is invalid", () => invalid("registry.example.com/", /registry without repository/));
test("#17 an empty tag is invalid", () => invalid("acme/api:", /bad tag/));
test("#18 a tag starting with - is invalid", () => invalid("acme/api:-bad", /bad tag/));

test("#19 tags of 128 characters are valid, 129 invalid", () => {
  assert.equal(image(`acme/api:${"t".repeat(128)}`).tag.length, 128);
  invalid(`acme/api:${"t".repeat(129)}`, /bad tag/);
});

test("#20 a short sha256 digest is invalid", () => invalid("acme/api@sha256:abc", /bad digest/));

test("#21 a non-sha256 digest is valid grammar but not comparable", () => {
  const i = image(`acme/api@md5:${"c".repeat(32)}`);
  assert.equal(i.digest, `md5:${"c".repeat(32)}`);
  assert.equal(isComparableDigest(i.digest), false);
  // Equal md5 digests prove nothing (only sha256 is comparable): same reference, unproven.
  assert.equal(sameBuild(i, image(`acme/api@md5:${"c".repeat(32)}`)), "unproven");
});

test("#22 an empty path component is invalid", () => invalid("acme//api", /bad path component/));
test("#23 two tag colons are invalid", () => invalid("acme/api:1:2", /bad tag/));
test("#24 multiple @ are invalid", () => invalid(`acme/api@sha256:${HEX64}@sha256:${HEX64}`, /multiple @/));

test("#25 surrounding whitespace is trimmed (raw kept); inner whitespace is invalid", () => {
  const i = image("  acme/api:1  ");
  assert.deepEqual([i.repository, i.tag, i.raw], ["acme/api", "1", "  acme/api:1  "]);
  invalid("acme/ api:1", /whitespace/);
});

test("#26 the DOCKER| prefix is case-insensitive", () => assert.equal(image("docker|acme/api:1").tag, "1"));
test("#27 DOCKER| alone is invalid for the generic parser", () => invalid("DOCKER|", /empty after DOCKER\|/));

test("#28 COMPOSE| and KUBE| are multi-container", () => {
  assert.equal(parseImage("COMPOSE|dmVyc2lvbjogJzMn").kind, "multi-container");
  assert.equal(parseImage("KUBE|YXBpVmVyc2lvbg==").kind, "multi-container");
});

test("#29 SITECONTAINERS is the sidecar model", () => assert.equal(parseImage("SITECONTAINERS").kind, "sidecar"));

test("#30 runtime stacks are not containers", () => {
  for (const raw of ["NODE|20-lts", "PYTHON|3.11", "DOTNETCORE|8.0"]) assert.equal(parseImage(raw).kind, "non-container", raw);
});

test("#31 empty, null and undefined are not containers", () => {
  for (const raw of ["", null, undefined]) assert.equal(parseImage(raw).kind, "non-container");
});

test("#32 a registry port is significant: never merged with the portless host", () => {
  const a = image("registry.example.com:443/acme/api:1");
  const b = image("registry.example.com/acme/api:1");
  assert.notEqual(a.registry, b.registry);
  assert.equal(sameBuild(a, b), "different");
});

test("#33-#35 a dot marks a host only before the first slash; underscores are Hub namespaces", () => {
  assert.equal(image("a.b").repository, "library/a.b");
  assert.equal(image("a.b/c").registry, "a.b");
  const hub = image("my_registry/app");
  assert.deepEqual([hub.registry, hub.repository], ["docker.io", "my_registry/app"]);
});

test("#36 identical tags are the same reference, unproven", () => {
  assert.equal(sameBuild(image("acme/api:1.2.3"), image("acme/api:1.2.3")), "unproven");
});

test("#37 the same digest with different tags is proven", () => {
  assert.equal(sameBuild(image(`acme/api:1@sha256:${HEX64}`), image(`acme/api:2@sha256:${HEX64.toUpperCase()}`)), "proven");
});

test("#38 a different digest with the same tag is different", () => {
  assert.equal(sameBuild(image(`acme/api:1@sha256:${HEX64}`), image(`acme/api:1@sha256:${HEX64B}`)), "different");
});

test("sameBuild: anything that is not an image is unproven; one-sided digest falls back to references", () => {
  assert.equal(sameBuild(parseImage("NODE|20-lts"), image("acme/api:1")), "unproven");
  assert.equal(sameBuild(image(`acme/api:1@sha256:${HEX64}`), image("acme/api:1")), "unproven");
  assert.equal(sameBuild(image("acme/api:1"), image("acme/api:2")), "different");
});

test("a bad registry port is invalid", () => invalid("registry.example.com:http/acme/api", /bad registry port/));

// --- the original engine's linuxFxVersion behaviours (parity) ----------------------------------

test("parity: a normal private-registry tag reference", () => {
  const i = parseLinuxFxVersion("DOCKER|registry.example.com/acme-api:1.4.0");
  assert.deepEqual([i.kind, i.registry, i.repository, i.tag, i.digest], ["image", "registry.example.com", "acme-api", "1.4.0", null]);
});

test("parity: a digest-pinned reference has a digest and no tag", () => {
  const digest = `sha256:${HEX64}`;
  const i = parseLinuxFxVersion(`DOCKER|registry.example.com/acme-worker@${digest}`);
  assert.deepEqual([i.repository, i.digest, i.tag], ["acme-worker", digest, null]);
});

test("parity: a nested repository path survives intact", () => {
  const i = parseLinuxFxVersion("DOCKER|registry.example.com/team/acme/acme-api:2.0.1");
  assert.deepEqual([i.registry, i.repository, i.tag], ["registry.example.com", "team/acme/acme-api", "2.0.1"]);
});

test("parity: a registry port is not mistaken for a tag", () => {
  const i = parseLinuxFxVersion("DOCKER|registry.example.com:5000/acme/app:3.1");
  assert.deepEqual([i.registry, i.repository, i.tag], ["registry.example.com:5000", "acme/app", "3.1"]);
});

test("parity: a portless registry with no tag is implicit latest, not tagged", () => {
  const i = parseLinuxFxVersion("DOCKER|registry.example.com/app");
  assert.deepEqual([i.kind, i.repository, i.tag, i.implicitTag], ["image", "app", "latest", true]);
});

test("parity: a Docker Hub namespace stays in the repository, not the registry", () => {
  const i = parseLinuxFxVersion("DOCKER|library/redis:7-alpine");
  assert.deepEqual([i.registry, i.implicitRegistry, i.repository, i.tag], ["docker.io", true, "library/redis", "7-alpine"]);
});

test("parity: non-container runtimes, blanks and prefix-less values are never images", () => {
  for (const raw of ["NODE|20-lts", "PYTHON|3.11", "", "   ", "garbage-without-pipe", null]) {
    assert.equal(parseLinuxFxVersion(raw).kind, "non-container", `expected non-container for ${JSON.stringify(raw)}`);
  }
});

test("parity: DOCKER| with an empty reference is not a container (App Service semantics)", () => {
  assert.equal(parseLinuxFxVersion("DOCKER|").kind, "non-container");
  assert.equal(parseLinuxFxVersion("DOCKER|   ").kind, "non-container");
});

test("parity: COMPOSE / multi-container never names a single image", () => {
  assert.equal(parseLinuxFxVersion("COMPOSE|dmVyc2lvbjogJzMn").kind, "multi-container");
  assert.equal(parseLinuxFxVersion("SITECONTAINERS").kind, "sidecar");
});
