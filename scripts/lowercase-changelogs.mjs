// lowercase the boilerplate changesets writes into CHANGELOG.md (`### Major Changes`,
// `- Updated dependencies`), everything else is authored text and stays as is.
// chained after `changeset version`; idempotent.
//
//   node scripts/lowercase-changelogs.mjs           rewrite in place
//   node scripts/lowercase-changelogs.mjs --check   report drift, exit 1 (for ci)

import { existsSync, readFileSync, writeFileSync } from "node:fs";

const FILE = "CHANGELOG.md";
const RULES = [
	[/^(#{1,4} )(Major|Minor|Patch) Changes$/gm, (_m, hashes, kind) => `${hashes}${kind.toLowerCase()} changes`],
	[/^(\s*[-*] )Updated dependencies\b/gm, (_m, bullet) => `${bullet}updated dependencies`],
];

const check = process.argv.includes("--check");

if (!existsSync(FILE)) {
	console.log("no changelog yet");
	process.exit(0);
}

const before = readFileSync(FILE, "utf8");
const after = RULES.reduce((acc, [pattern, replace]) => acc.replace(pattern, replace), before);

if (after === before) {
	console.log("changelog casing ok");
} else if (check) {
	console.error(`changelog casing drift in ${FILE}, run \`node scripts/lowercase-changelogs.mjs\``);
	process.exit(1);
} else {
	writeFileSync(FILE, after);
	console.log(`lowercased changelog boilerplate in ${FILE}`);
}
