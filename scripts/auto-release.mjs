// create a github release `v<version>` for the published version if it doesn't exist yet.
// body: the CHANGELOG.md section of this version (if any) + commits since the previous tag.
// only versions that actually reached npm are released. DRY_RUN=1 prints instead.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const REPO = process.env.GITHUB_REPOSITORY ?? "neverlane/node-snet";
const TARGET = process.env.GITHUB_SHA ?? "HEAD";
const DRY_RUN = process.env.DRY_RUN === "1";

const { name, version } = JSON.parse(readFileSync("package.json", "utf8"));
const tag = `v${version}`;

const git = (args) => {
	try {
		return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return "";
	}
};

function isPublished() {
	try {
		return (
			execFileSync("npm", ["view", `${name}@${version}`, "version"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim() === version
		);
	} catch {
		return false;
	}
}

function releaseExists() {
	try {
		execFileSync("gh", ["release", "view", tag, "--repo", REPO], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function changelogSection() {
	if (!existsSync("CHANGELOG.md")) return "";
	const text = readFileSync("CHANGELOG.md", "utf8");
	const start = text.indexOf(`\n## ${version}\n`);
	if (start === -1) return "";
	const rest = text.slice(start + `\n## ${version}\n`.length);
	const end = rest.search(/\n## \d/);
	return (end === -1 ? rest : rest.slice(0, end)).trim();
}

function buildBody() {
	const previous = git(["tag", "--list", "v*", "--sort=-v:refname"])
		.split("\n")
		.find((t) => t && t !== tag);
	const log = git(["log", "--no-merges", "--format=%h%x09%s", previous ? `${previous}..${TARGET}` : TARGET]);
	const commits = log
		? log
				.split("\n")
				.map((line) => {
					const [short, ...rest] = line.split("\t");
					return `- ${rest.join("\t")} (${short})`;
				})
				.join("\n")
		: "_no notable changes_";
	const header = `[${name}@${version}](https://www.npmjs.com/package/${name}/v/${version})`;
	const changes = changelogSection();
	return [header, changes, `### commits${previous ? ` since ${previous}` : ""}\n\n${commits}`].filter(Boolean).join("\n\n");
}

// right after `npm publish` the registry can take a few minutes to serve the new version
async function waitPublished(timeoutMs = 5 * 60_000, stepMs = 15_000) {
	const start = Date.now();
	while (!isPublished()) {
		if (Date.now() - start > timeoutMs) return false;
		console.log(`waiting for ${name}@${version} to show up on npm...`);
		await new Promise((r) => setTimeout(r, stepMs));
	}
	return true;
}

// only wait when this run just published (publish.mjs leaves a marker), otherwise check once
const justPublished = process.env.SNET_JUST_PUBLISHED === "1" || existsSync(".just-published");
if (!DRY_RUN && !(justPublished ? await waitPublished() : isPublished())) {
	console.log(`skip ${tag}: ${name}@${version} is not on npm`);
	process.exit(0);
}
if (!DRY_RUN && releaseExists()) {
	console.log(`skip ${tag}: release already exists`);
	process.exit(0);
}

const body = buildBody();
if (DRY_RUN) {
	console.log(`\n=== ${tag} ===\n${body}\n`);
	process.exit(0);
}

const args = ["release", "create", tag, "--repo", REPO, "--target", TARGET, "--title", tag, "--notes", body];
if (version.includes("-")) args.push("--prerelease");
console.log(`creating release ${tag}`);
execFileSync("gh", args, { stdio: ["ignore", "inherit", "inherit"] });
