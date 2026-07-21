import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import * as cheerio from "cheerio";

export const SEARCH_URL =
  "https://nursingcareers-ohsu.icims.com/jobs/search?searchKeyword=RN";
const TITLE_PATTERN = /\b(?:RN|Registered Nurse)\b/i;
const LISTINGS_START = "<!-- OHSU-JOBS:START -->";
const LISTINGS_END = "<!-- OHSU-JOBS:END -->";

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function directJobUrl(value) {
  const url = new URL(value, SEARCH_URL);
  url.searchParams.delete("in_iframe");
  return url.toString();
}

export function parseJobsPage(html) {
  const $ = cheerio.load(html);
  if ($(".iCIMS_JobsTable").length === 0) {
    throw new Error("OHSU search returned an unexpected page");
  }

  const header = clean($(".iCIMS_SearchResultsHeader").text());
  const totalPages = Number(header.match(/Page\s+\d+\s+of\s+(\d+)/i)?.[1] ?? 1);
  const jobs = [];

  $(".iCIMS_JobCardItem").each((_, card) => {
    const link = $(card).find(".title a").first();
    const href = link.attr("href");
    const title = clean(link.find("h3").text());
    const titleAttribute = clean(link.attr("title"));
    const id =
      titleAttribute.match(/^(\d+)\s+-/)?.[1] ??
      href?.match(/\/jobs\/(\d+)\//)?.[1] ??
      "";
    if (!href || !id || !title || !TITLE_PATTERN.test(title)) return;

    const fields = new Map();
    $(card)
      .find(".iCIMS_JobHeaderTag")
      .each((__, field) => {
        const label = clean($(field).find("dt").text()).toLowerCase();
        const value = clean($(field).find("dd").text());
        if (label) fields.set(label, value);
      });

    jobs.push({
      id,
      title,
      location: clean($(card).find(".header.left span:not(.sr-only)").first().text()),
      requisitionId: fields.get("requisition id") ?? id,
      department: fields.get("posting department") ?? "Not listed",
      positionType: fields.get("position type") ?? "Not listed",
      newGrad: fields.get("available for new grads") ?? "Not listed",
      url: directJobUrl(href),
    });
  });

  return { jobs, totalPages: Math.max(1, totalPages || 1) };
}

async function fetchPage(page, fetchImpl) {
  const url = new URL(SEARCH_URL);
  url.searchParams.set("in_iframe", "1");
  if (page > 0) url.searchParams.set("pr", String(page));

  const response = await fetchImpl(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "ohsu-rn-job-monitor/1.0",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`OHSU search returned HTTP ${response.status}`);
  return parseJobsPage(await response.text());
}

export async function fetchJobs(fetchImpl = fetch) {
  const first = await fetchPage(0, fetchImpl);
  const allJobs = [...first.jobs];
  for (let page = 1; page < Math.min(first.totalPages, 20); page += 1) {
    allJobs.push(...(await fetchPage(page, fetchImpl)).jobs);
  }

  return [...new Map(allJobs.map((job) => [job.id, job])).values()];
}

async function readState(statePath) {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8"));
    return {
      initialized: parsed.initialized === true,
      seen: Array.isArray(parsed.seen) ? parsed.seen.map(String) : [],
    };
  } catch (error) {
    if (error.code === "ENOENT") return { initialized: false, seen: [] };
    throw new Error(`Could not read ${statePath}: ${error.message}`);
  }
}

export function buildAlert(jobs) {
  const noun = jobs.length === 1 ? "role" : "roles";
  const sections = jobs.map(
    (job) =>
      `## [${job.title}](${job.url})\n\n- Location: ${job.location}\n- Department: ${job.department}\n- Position type: ${job.positionType}\n- Available for new grads: ${job.newGrad}\n- Requisition: ${job.requisitionId}`,
  );

  return [
    `# ${jobs.length} new OHSU RN ${noun}`,
    "",
    ...sections.flatMap((section) => [section, ""]),
    `Source: [OHSU RN job search](${SEARCH_URL})`,
    "",
    `_Checked ${new Date().toISOString()}_`,
  ].join("\n");
}

function escapeTableCell(value) {
  return clean(value).replace(/\|/g, "\\|");
}

export function buildListingsSection(jobs) {
  const noun = jobs.length === 1 ? "opening" : "openings";
  const rows = jobs.length
    ? jobs.map(
        (job) =>
          `| [${escapeTableCell(job.title)}](${job.url}) | ${escapeTableCell(job.location)} | ${escapeTableCell(job.department)} | ${escapeTableCell(job.newGrad)} | ${escapeTableCell(job.requisitionId)} |`,
      )
    : ["| No matching RN openings are currently listed. |  |  |  |  |"];

  return [
    LISTINGS_START,
    `**${jobs.length} current ${noun}**`,
    "",
    "| Position | Location | Department | New grads | Requisition |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
    `[View the full OHSU RN search](${SEARCH_URL})`,
    LISTINGS_END,
  ].join("\n");
}

export async function updateReadme(readmePath, jobs) {
  if (!readmePath) return false;
  const current = await readFile(readmePath, "utf8");
  const section = buildListingsSection(jobs);
  const pattern = new RegExp(`${LISTINGS_START}[\\s\\S]*?${LISTINGS_END}`);
  const next = current.replace(pattern, section);
  if (next === current) return false;
  await writeFile(readmePath, next, "utf8");
  return true;
}

async function setActionsOutputs(values, outputPath) {
  if (!outputPath) return;
  const lines = Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  await appendFile(outputPath, `${lines}\n`, "utf8");
}

export async function runMonitor({
  statePath,
  alertPath,
  newJobsPath,
  readmePath,
  actionsOutputPath,
  sendTestAlert = false,
  fetchImpl = fetch,
}) {
  const previous = await readState(statePath);
  const jobs = await fetchJobs(fetchImpl);
  const seen = new Set(previous.seen);
  const unseen = jobs.filter((job) => !seen.has(job.id));
  const newJobs = sendTestAlert ? jobs.slice(0, 1) : previous.initialized ? unseen : [];

  for (const job of jobs) seen.add(job.id);
  const nextState = { initialized: true, seen: [...seen].sort() };
  const stateChanged =
    !previous.initialized ||
    JSON.stringify(nextState.seen) !== JSON.stringify([...previous.seen].sort());
  const readmeChanged = await updateReadme(readmePath, jobs);

  if (stateChanged) {
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
  }
  if (newJobs.length > 0) {
    await mkdir(dirname(alertPath), { recursive: true });
    await writeFile(alertPath, buildAlert(newJobs), "utf8");
    if (newJobsPath) {
      await mkdir(dirname(newJobsPath), { recursive: true });
      await writeFile(newJobsPath, `${JSON.stringify(newJobs, null, 2)}\n`, "utf8");
    }
  }

  await setActionsOutputs(
    {
      new_count: newJobs.length,
      current_count: jobs.length,
      state_changed: stateChanged,
      readme_changed: readmeChanged,
      repo_changed: stateChanged || readmeChanged,
      baseline_created: !previous.initialized && !sendTestAlert,
    },
    actionsOutputPath,
  );

  return {
    jobs,
    newJobs,
    stateChanged,
    readmeChanged,
    baselineCreated: !previous.initialized,
  };
}

function parseArgs(args) {
  const options = {
    statePath: "data/seen_jobs.json",
    alertPath: "new_jobs.md",
    newJobsPath: undefined,
    readmePath: "README.md",
    actionsOutputPath: process.env.GITHUB_OUTPUT,
    sendTestAlert: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--send-test-alert") options.sendTestAlert = true;
    else if (arg === "--state") options.statePath = args[++index];
    else if (arg === "--alert-file") options.alertPath = args[++index];
    else if (arg === "--new-jobs-file") options.newJobsPath = args[++index];
    else if (arg === "--readme") options.readmePath = args[++index];
    else if (arg === "--output") options.actionsOutputPath = args[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }

  options.statePath = resolve(options.statePath);
  options.alertPath = resolve(options.alertPath);
  if (options.newJobsPath) options.newJobsPath = resolve(options.newJobsPath);
  options.readmePath = resolve(options.readmePath);
  return options;
}

async function main() {
  const result = await runMonitor(parseArgs(process.argv.slice(2)));
  if (result.baselineCreated && result.newJobs.length === 0) {
    console.log(`Baseline saved with ${result.jobs.length} current jobs; no alert sent.`);
  } else {
    console.log(`Found ${result.jobs.length} current jobs and ${result.newJobs.length} new jobs.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
