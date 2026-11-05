import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RELEASE_CHECK_NAME = "Merge Gate";
export const RELEASE_CHECK_APP_ID = 15368;
const MAX_PAGINATION_PAGES = 10_000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function nextPageFromLink(linkHeader, currentUrl, apiRoot) {
  if (!linkHeader) return undefined;
  for (const link of linkHeader.split(/,(?=\s*<)/u)) {
    const match = /^\s*<([^>]+)>\s*;(.*)$/u.exec(link);
    if (!match) continue;
    const relation = /(?:^|;)\s*rel="?([^";]+)"?/u.exec(match[2]);
    if (!relation?.[1].split(/\s+/u).includes("next")) continue;
    const nextUrl = new URL(match[1], currentUrl);
    assert(
      nextUrl.origin === apiRoot.origin && nextUrl.pathname.startsWith(apiRoot.pathname),
      "GitHub pagination link escaped the configured API origin",
    );
    return nextUrl.toString();
  }
  return undefined;
}

async function collectPages({ url, collectionKey, token, fetchImpl, apiRoot }) {
  const items = [];
  const visited = new Set();
  let expectedTotal;
  let currentUrl = url.toString();
  let pageCount = 0;

  while (currentUrl) {
    assert(!visited.has(currentUrl), "GitHub pagination repeated a page URL");
    visited.add(currentUrl);
    pageCount += 1;
    assert(pageCount <= MAX_PAGINATION_PAGES, "GitHub pagination exceeded its safety bound");

    const response = await fetchImpl(currentUrl, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub API request failed with HTTP ${response.status}`);
    }
    const payload = await response.json();
    assert(
      payload &&
        Number.isSafeInteger(payload.total_count) &&
        payload.total_count >= 0 &&
        Array.isArray(payload[collectionKey]),
      `GitHub API response is missing total_count or ${collectionKey}`,
    );
    if (expectedTotal === undefined) expectedTotal = payload.total_count;
    assert(
      expectedTotal === payload.total_count,
      `GitHub API total_count changed while reading ${collectionKey}`,
    );
    items.push(...payload[collectionKey]);
    currentUrl = nextPageFromLink(response.headers.get("link"), currentUrl, apiRoot) ?? "";
  }

  assert(
    items.length === expectedTotal,
    `GitHub API pagination was incomplete for ${collectionKey}: expected ${expectedTotal}, received ${items.length}`,
  );
  return items;
}

export async function fetchReleaseCheckRuns({
  apiUrl,
  repository,
  expectedSha,
  token,
  fetchImpl = globalThis.fetch,
}) {
  assert(typeof token === "string" && token.length > 0, "GITHUB_TOKEN is required");
  assert(/^[^/]+\/[^/]+$/u.test(repository), "repository must be owner/repo");
  assert(typeof fetchImpl === "function", "a fetch implementation is required");
  const apiRoot = new URL(apiUrl.endsWith("/") ? apiUrl : `${apiUrl}/`);
  assert(apiRoot.protocol === "https:", "GitHub API must use HTTPS");
  const suitesUrl = new URL(
    `repos/${repository}/commits/${encodeURIComponent(expectedSha)}/check-suites`,
    apiRoot,
  );
  suitesUrl.searchParams.set("app_id", String(RELEASE_CHECK_APP_ID));
  suitesUrl.searchParams.set("per_page", "100");
  const suites = await collectPages({
    url: suitesUrl,
    collectionKey: "check_suites",
    token,
    fetchImpl,
    apiRoot,
  });

  const checkRuns = [];
  const seenRunIds = new Set();
  for (const suite of suites) {
    assert(
      Number.isSafeInteger(suite?.id) && suite.id > 0,
      "GitHub returned an invalid check-suite ID",
    );
    assert(
      suite?.head_sha === expectedSha && suite?.app?.id === RELEASE_CHECK_APP_ID,
      "GitHub returned a check suite for another commit or app",
    );
    const runsUrl = new URL(`repos/${repository}/check-suites/${suite.id}/check-runs`, apiRoot);
    runsUrl.searchParams.set("check_name", RELEASE_CHECK_NAME);
    runsUrl.searchParams.set("filter", "all");
    runsUrl.searchParams.set("per_page", "100");
    const suiteRuns = await collectPages({
      url: runsUrl,
      collectionKey: "check_runs",
      token,
      fetchImpl,
      apiRoot,
    });
    for (const checkRun of suiteRuns) {
      assert(
        checkRun?.head_sha === expectedSha && checkRun?.app?.id === RELEASE_CHECK_APP_ID,
        "GitHub returned a check run for another commit or app",
      );
      assert(
        checkRun?.name === RELEASE_CHECK_NAME &&
          Number.isSafeInteger(checkRun?.id) &&
          checkRun.id > 0,
        "GitHub returned an invalid Merge Gate check run",
      );
      assert(!seenRunIds.has(checkRun.id), `GitHub repeated check run ${checkRun.id}`);
      seenRunIds.add(checkRun.id);
      checkRuns.push(checkRun);
    }
  }

  return {
    total_count: checkRuns.length,
    check_runs: checkRuns,
    check_suites_count: suites.length,
  };
}

function makeRun(id, expectedSha, conclusion = "success") {
  return {
    id,
    name: RELEASE_CHECK_NAME,
    head_sha: expectedSha,
    app: { id: RELEASE_CHECK_APP_ID },
    status: "completed",
    conclusion,
  };
}

export async function runPaginationFixture() {
  const expectedSha = "expected-sha";
  const apiRoot = "https://api.github.test/";
  const requested = [];
  const pageOneRuns = Array.from({ length: 100 }, (_, index) => makeRun(index + 1, expectedSha));
  const fetchImpl = async (input) => {
    const url = new URL(input);
    requested.push(url.toString());
    if (url.pathname.endsWith("/check-suites") && !url.pathname.includes("/check-suites/")) {
      if (url.searchParams.get("page") === "2") {
        return new Response(
          JSON.stringify({
            total_count: 2,
            check_suites: [{ id: 11, head_sha: expectedSha, app: { id: RELEASE_CHECK_APP_ID } }],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          total_count: 2,
          check_suites: [{ id: 10, head_sha: expectedSha, app: { id: RELEASE_CHECK_APP_ID } }],
        }),
        {
          headers: {
            "content-type": "application/json",
            link: `<${apiRoot}repos/owner/repo/commits/${expectedSha}/check-suites?app_id=${RELEASE_CHECK_APP_ID}&per_page=100&page=2>; rel="next"`,
          },
        },
      );
    }
    if (url.pathname.endsWith("/check-suites/10/check-runs")) {
      if (url.searchParams.get("page") === "2") {
        return new Response(
          JSON.stringify({
            total_count: 101,
            check_runs: [makeRun(101, expectedSha, "failure")],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ total_count: 101, check_runs: pageOneRuns }), {
        headers: {
          "content-type": "application/json",
          link: `<${apiRoot}repos/owner/repo/check-suites/10/check-runs?check_name=Merge%20Gate&filter=all&per_page=100&page=2>; rel="next"`,
        },
      });
    }
    if (url.pathname.endsWith("/check-suites/11/check-runs")) {
      return new Response(JSON.stringify({ total_count: 0, check_runs: [] }), {
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fixture URL: ${url}`);
  };
  const collected = await fetchReleaseCheckRuns({
    apiUrl: apiRoot,
    repository: "owner/repo",
    expectedSha,
    token: "fixture-token",
    fetchImpl,
  });
  assert(collected.check_runs.length === 101, "fixture did not collect both check-run pages");
  assert(collected.check_suites_count === 2, "fixture did not collect both check-suite pages");
  assert(requested.length === 5, "fixture did not follow every pagination link");
  const selected = collected.check_runs.reduce((latest, run) =>
    run.id > latest.id ? run : latest,
  );
  assert(
    selected.id === 101 && selected.conclusion === "failure",
    "newer paged failure was missed",
  );

  const incompleteFetch = async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/check-suites") && !url.pathname.includes("/check-suites/")) {
      return new Response(
        JSON.stringify({
          total_count: 1,
          check_suites: [{ id: 12, head_sha: expectedSha, app: { id: RELEASE_CHECK_APP_ID } }],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ total_count: 101, check_runs: [makeRun(200, expectedSha)] }),
      {
        headers: { "content-type": "application/json" },
      },
    );
  };
  let incompleteRejected = false;
  try {
    await fetchReleaseCheckRuns({
      apiUrl: apiRoot,
      repository: "owner/repo",
      expectedSha,
      token: "fixture-token",
      fetchImpl: incompleteFetch,
    });
  } catch (error) {
    incompleteRejected = String(error).includes("pagination was incomplete");
  }
  assert(incompleteRejected, "truncated GitHub results must fail closed");
  process.stdout.write(
    "release check pagination fixtures ok: paged suites, 101 runs, newest failure, truncation\n",
  );
  return collected;
}

async function fetchFromCli(apiUrl, repository, expectedSha, outputPath) {
  const payload = await fetchReleaseCheckRuns({
    apiUrl,
    repository,
    expectedSha,
    token: process.env.GITHUB_TOKEN,
  });
  await writeFile(path.resolve(outputPath), `${JSON.stringify(payload)}\n`);
  process.stdout.write(
    `Fetched ${payload.check_runs.length} Merge Gate runs from ${payload.check_suites_count} check suites for ${expectedSha}\n`,
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const [, , ...args] = process.argv;
  if (args.length === 1 && args[0] === "--fixture") {
    await runPaginationFixture();
  } else if (args.length === 4) {
    await fetchFromCli(args[0], args[1], args[2], args[3]);
  } else {
    throw new Error(
      "Usage: node scripts/fetch-release-check-runs.mjs --fixture|<api-url> <owner/repo> <sha> <output-json>",
    );
  }
}
