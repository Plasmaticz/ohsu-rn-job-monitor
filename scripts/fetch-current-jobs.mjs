import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { fetchJobs } from "./check-jobs.mjs";

const [outputPath] = process.argv.slice(2);
if (!outputPath) throw new Error("Usage: fetch-current-jobs.mjs OUTPUT_PATH");

const resolvedPath = resolve(outputPath);
const jobs = await fetchJobs();
await mkdir(dirname(resolvedPath), { recursive: true });
await writeFile(resolvedPath, `${JSON.stringify(jobs, null, 2)}\n`, "utf8");
console.log(`Saved ${jobs.length} current jobs.`);
