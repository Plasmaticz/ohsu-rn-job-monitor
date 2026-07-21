import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildListingsSection,
  fetchJobs,
  parseJobsPage,
  runMonitor,
} from "../scripts/check-jobs.mjs";
import {
  buildDailyDigestPayloads,
  buildNewRolePayloads,
  sendDiscordJobs,
} from "../scripts/send-discord.mjs";

function card({
  id,
  title,
  location = "US-OR-Portland",
  department = "Medical ICU",
  positionType = "Regular Full-Time",
}) {
  return `
    <li class="iCIMS_JobCardItem">
      <div class="header left"><span class="sr-only">Job Locations</span><span>${location}</span></div>
      <div class="title">
        <a href="https://nursingcareers-ohsu.icims.com/jobs/${id}/sample/job?in_iframe=1" title="${id} - ${title}"><h3>${title}</h3></a>
      </div>
      <div class="iCIMS_JobHeaderTag"><dt>Position Type</dt><dd>${positionType}</dd></div>
      <div class="iCIMS_JobHeaderTag"><dt>Posting Department</dt><dd>${department}</dd></div>
      <div class="iCIMS_JobHeaderTag"><dt>Available for New Grads</dt><dd>Unreliable value</dd></div>
      <div class="iCIMS_JobHeaderTag"><dt>Requisition ID</dt><dd>2026-${id}</dd></div>
    </li>`;
}

function page(cards, current = 1, total = 1) {
  return `
    <div class="iCIMS_SearchResultsHeader">Search Results Page ${current} of ${total}</div>
    <ul class="iCIMS_JobsTable">${cards.join("\n")}</ul>`;
}

function htmlResponse(html) {
  return { ok: true, text: async () => html };
}

test("parser extracts RN card fields and ignores unrelated titles", () => {
  const parsed = parseJobsPage(
    page([
      card({ id: "40465", title: "RN, Critical Care &amp; Float Pool" }),
      card({ id: "40416", title: "Director of Nursing" }),
    ], 1, 3),
  );

  assert.equal(parsed.totalPages, 3);
  assert.equal(parsed.jobs.length, 1);
  assert.equal(parsed.jobs[0].title, "RN, Critical Care & Float Pool");
  assert.equal(parsed.jobs[0].department, "Medical ICU");
  assert.equal("newGrad" in parsed.jobs[0], false);
  assert.equal(parsed.jobs[0].requisitionId, "2026-40465");
  assert.equal(parsed.jobs[0].url.includes("in_iframe"), false);
});

test("parser accepts OHSU's valid no-results page", () => {
  assert.deepEqual(
    parseJobsPage("<main>Sorry, no jobs were found that match your search criteria.</main>"),
    { jobs: [], totalPages: 1 },
  );
});

test("fetcher combines both keyword searches and removes duplicate IDs", async () => {
  const requests = [];
  const jobs = await fetchJobs(async (url) => {
    requests.push(String(url));
    const term = url.searchParams.get("searchKeyword");
    const secondPage = url.searchParams.get("pr") === "1";
    if (term === "RN New Grad") {
      return htmlResponse(
        page([card({ id: "101", title: "Registered Nurse, Clinic" })]),
      );
    }
    return htmlResponse(
      secondPage
        ? page([card({ id: "101", title: "Registered Nurse, Clinic" })], 2, 2)
        : page([card({ id: "100", title: "RN, Acute Care" })], 1, 2),
    );
  });

  assert.equal(requests.length, 3);
  assert.deepEqual(jobs.map((job) => job.id), ["100", "101"]);
  assert.deepEqual(jobs[0].matchedSearches, ["RN Resident"]);
  assert.deepEqual(jobs[1].matchedSearches, ["RN Resident", "RN New Grad"]);
});

test("monitor creates a quiet baseline then reports only unseen roles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ohsu-monitor-"));
  const statePath = join(directory, "seen.json");
  const alertPath = join(directory, "alert.md");
  const newJobsPath = join(directory, "new.json");
  const readmePath = join(directory, "README.md");

  try {
    await writeFile(statePath, '{"initialized":false,"seen":[]}\n');
    await writeFile(
      readmePath,
      "# Monitor\n\n<!-- OHSU-JOBS:START -->\nWaiting\n<!-- OHSU-JOBS:END -->\n",
    );
    const firstHtml = page([card({ id: "100", title: "RN, Acute Care" })]);
    const first = await runMonitor({
      statePath,
      alertPath,
      newJobsPath,
      readmePath,
      fetchImpl: async () => htmlResponse(firstHtml),
    });
    assert.equal(first.newJobs.length, 0);

    const secondHtml = page([
      card({ id: "101", title: "RN, Pediatric ICU" }),
      card({ id: "100", title: "RN, Acute Care" }),
    ]);
    const second = await runMonitor({
      statePath,
      alertPath,
      newJobsPath,
      readmePath,
      fetchImpl: async () => htmlResponse(secondHtml),
    });
    assert.deepEqual(second.newJobs.map((job) => job.id), ["101"]);
    assert.match(await readFile(alertPath, "utf8"), /RN, Pediatric ICU/);
    assert.equal(JSON.parse(await readFile(newJobsPath, "utf8")).length, 1);
    assert.match(await readFile(readmePath, "utf8"), /2 current openings/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("manual test alert sends exactly one current role", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ohsu-test-alert-"));
  const statePath = join(directory, "seen.json");
  const alertPath = join(directory, "alert.md");
  const html = page([
    card({ id: "101", title: "RN, Pediatric ICU" }),
    card({ id: "100", title: "RN, Acute Care" }),
  ]);

  try {
    await writeFile(statePath, '{"initialized":true,"seen":["100","101"]}\n');
    const result = await runMonitor({
      statePath,
      alertPath,
      sendTestAlert: true,
      fetchImpl: async () => htmlResponse(html),
    });
    assert.deepEqual(result.newJobs.map((job) => job.id), ["101"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("README section shows an empty-state message", () => {
  assert.match(buildListingsSection([]), /No matching RN openings/);
});

test("new Discord alerts are embedded and notify everyone", () => {
  const job = {
    ...parseJobsPage(page([card({ id: "100", title: "RN, Acute Care" })])).jobs[0],
    matchedSearches: ["RN Resident"],
  };
  const [payload] = buildNewRolePayloads([job]);
  assert.match(payload.content, /@everyone/);
  assert.match(payload.content, /\*\*NEW ROLE\*\*/);
  assert.deepEqual(payload.allowed_mentions, { parse: ["everyone"] });
  assert.equal(payload.embeds[0].title, "RN, Acute Care");
  assert.equal(payload.embeds[0].fields[2].value, "RN Resident");
});

test("daily Discord digest batches roles without mass mentions", () => {
  const job = {
    ...parseJobsPage(page([card({ id: "100", title: "RN, Acute Care" })])).jobs[0],
    matchedSearches: ["RN New Grad"],
  };
  const payloads = buildDailyDigestPayloads(
    Array.from({ length: 9 }, (_, index) => ({ ...job, id: String(index) })),
  );
  assert.equal(payloads.length, 2);
  assert.equal(payloads[0].embeds.length, 8);
  assert.deepEqual(payloads[0].allowed_mentions, { parse: [] });
});

test("Discord sender waits for webhook confirmation", async () => {
  const requests = [];
  const job = {
    ...parseJobsPage(page([card({ id: "100", title: "RN, Acute Care" })])).jobs[0],
    matchedSearches: ["RN Resident"],
  };
  await sendDiscordJobs(
    "https://discord.com/api/webhooks/example/token",
    [job],
    "new",
    async (url, options) => {
      requests.push({ url: String(url), options });
      return { ok: true };
    },
  );
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /wait=true/);
  assert.equal(JSON.parse(requests[0].options.body).embeds.length, 1);
});
