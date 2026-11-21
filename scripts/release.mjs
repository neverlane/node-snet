// full release pipeline: gate (typecheck + test) → build → publish to npm → github release.
//
// DRY_RUN=1          gate and build run for real, publish/release only print
// RELEASE_SKIP_GATE=1 skip typecheck/test (ci already ran them on this commit)

import { spawn } from "node:child_process";

const SKIP_GATE = process.env.RELEASE_SKIP_GATE === "1";

const STEPS = [
	...(SKIP_GATE
		? []
		: [
				{ label: "typecheck", command: "pnpm", args: ["typecheck"] },
				{ label: "tests", command: "pnpm", args: ["test"] },
			]),
	{ label: "build", command: "pnpm", args: ["build"] },
	{ label: "publish to npm", command: "node", args: ["scripts/publish.mjs"] },
	{ label: "github release", command: "node", args: ["scripts/auto-release.mjs"] },
];

const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

const run = (step) =>
	new Promise((resolve, reject) => {
		const child = spawn(step.command, step.args, { stdio: "inherit" });
		child.on("error", reject);
		child.on("exit", (code) =>
			code === 0 ? resolve() : reject(new Error(`${step.label} exited with code ${code ?? "null"}`)),
		);
	});

try {
	const startedAt = Date.now();
	for (const [i, step] of STEPS.entries()) {
		console.log(`\n${CYAN}[${i + 1}/${STEPS.length}] ${step.label}${RESET}`);
		console.log(`${DIM}$ ${step.command} ${step.args.join(" ")}${RESET}`);
		await run(step);
	}
	console.log(`\n${GREEN}✓ release complete in ${((Date.now() - startedAt) / 1000).toFixed(1)}s${RESET}`);
} catch (error) {
	console.error(`\n${RED}✗ release failed${RESET}`);
	console.error(error);
	process.exit(1);
}
