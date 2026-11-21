// publish node-snet when its current version is not on npm yet, so running this on every
// green master build is a no-op until the version is bumped (`pnpm version-packages`).
//
// DRY_RUN=1 prints the plan. in ci it adds --provenance (NO_PROVENANCE=1 to opt out).
// auth: npm trusted publishing (oidc) from release.yml, NODE_AUTH_TOKEN as fallback.
// prerelease versions (2.1.0-beta.0) go to the `next` dist-tag.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const DRY_RUN = process.env.DRY_RUN === "1";
const { name, version } = JSON.parse(readFileSync("package.json", "utf8"));
const id = `${name}@${version}`;

function isPublished() {
	try {
		const out = execFileSync("npm", ["view", id, "version"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return out === version;
	} catch {
		return false; // 404: new package or unpublished version
	}
}

if (isPublished()) {
	console.log(`skip ${id}: already on npm`);
	process.exit(0);
}

const args = ["publish", "--access", "public", "--no-git-checks"];
if (version.includes("-")) args.push("--tag", "next");
if (process.env.CI && process.env.NO_PROVENANCE !== "1") args.push("--provenance");

if (DRY_RUN) {
	console.log(`[dry-run] would run: pnpm ${args.join(" ")}`);
	process.exit(0);
}

console.log(`publishing ${id}`);
try {
	execFileSync("pnpm", args, { stdio: "inherit" });
} catch {
	console.error(
		"\nE404 on PUT under trusted publishing means npmjs.com has no trusted publisher for node-snet\n" +
			"(settings → trusted publisher → github actions: neverlane/node-snet, release.yml) — run `pnpm release:trust`,\n" +
			"or set the NPM_TOKEN repo secret as a fallback.",
	);
	process.exit(1);
}
