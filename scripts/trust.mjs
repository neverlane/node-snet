// register release.yml of this repo as the npm trusted publisher of node-snet.
// needs `npm login` as package owner and npm >= 11.10 (`npm trust`). DRY_RUN=1 prints only.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const REPO = process.env.GITHUB_REPOSITORY ?? "neverlane/node-snet";
const WORKFLOW = "release.yml";
const DRY_RUN = process.env.DRY_RUN === "1";
const { name } = JSON.parse(readFileSync("package.json", "utf8"));

const npm = (args) => execFileSync("npm", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const lastLine = (error) => String(error.stderr ?? error.message).trim().split("\n").at(-1);

try {
	const listing = npm(["trust", "list", name, "--json"]);
	if (listing.includes(REPO) && listing.includes(WORKFLOW)) {
		console.log(`${name} already trusts ${REPO}/${WORKFLOW}`);
		process.exit(0);
	}
	if (DRY_RUN) {
		console.log(`would trust ${REPO}/${WORKFLOW} for ${name}`);
		process.exit(0);
	}
	npm(["trust", "github", name, "--repo", REPO, "--file", WORKFLOW, "--allow-publish", "--yes"]);
	console.log(`trusted ${REPO}/${WORKFLOW} for ${name}`);
} catch (error) {
	console.error(`✗ ${name}: ${lastLine(error)}`);
	process.exit(1);
}
