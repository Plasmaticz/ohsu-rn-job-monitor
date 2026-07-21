import { readFile } from "node:fs/promises";

const [bodyPath, countValue] = process.argv.slice(2);
const token = process.env.GH_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;

if (!bodyPath || !countValue) throw new Error("Usage: create-issue.mjs BODY_PATH COUNT");
if (!token || !repository) throw new Error("GH_TOKEN and GITHUB_REPOSITORY are required");

const count = Number(countValue);
const body = await readFile(bodyPath, "utf8");
const noun = count === 1 ? "role" : "roles";
const response = await fetch(`https://api.github.com/repos/${repository}/issues`, {
  method: "POST",
  headers: {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "ohsu-rn-job-monitor/1.0",
    "X-GitHub-Api-Version": "2022-11-28",
  },
  body: JSON.stringify({
    title: `${count} new OHSU RN ${noun}`,
    body,
    labels: [],
  }),
});
if (!response.ok) {
  throw new Error(`GitHub issue creation failed (${response.status}): ${await response.text()}`);
}
const issue = await response.json();
console.log(`Created ${issue.html_url}`);
