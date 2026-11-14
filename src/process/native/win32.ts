/*
This basically spawns a long-running powershell script to get all the processes and their arguments.
On a VM, this results in ~30ms per scan.
A native module approach using C++ is around 15ms, and in my opinion is not worth the hassle.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { Logger } from "../../logger.ts";
import type { ProcessEntry } from "../../types.ts";

const log = new Logger("win32-ps", "blueBright").log;

const END_MARKER = "__EOF__";

// ASCII Unit Separator (31).
// Safe for parsing as it is forbidden in Windows filenames and rare in arguments.
const SEP = "\x1f";

const PS_SCRIPT = `
$ErrorActionPreference = "SilentlyContinue";
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
# Used to exit when the parent dies, since stdin is no longer read
$parent = [System.Diagnostics.Process]::GetProcessById(${process.pid});

# Subscribe first and snapshot second, so nothing is missed in between
$startWatcher = [System.Management.ManagementEventWatcher]::new("SELECT * FROM __InstanceCreationEvent WITHIN 1 WHERE TargetInstance ISA 'Win32_Process'");
$stopWatcher = [System.Management.ManagementEventWatcher]::new("SELECT * FROM __InstanceDeletionEvent WITHIN 1 WHERE TargetInstance ISA 'Win32_Process'");

$null = Register-ObjectEvent -InputObject $startWatcher -EventName EventArrived -SourceIdentifier "start";
$null = Register-ObjectEvent -InputObject $stopWatcher -EventName EventArrived -SourceIdentifier "stop";

$startWatcher.Start();
$stopWatcher.Start();
$searcher = [System.Management.ManagementObjectSearcher]::new("SELECT ProcessId, ExecutablePath, CommandLine, Name FROM Win32_Process");

# Pre-allocate 64KB to minimize resizing overhead
$sb = [System.Text.StringBuilder]::new(65536);
# Cast to char primitive for faster appending
$sep = [char]31;

$null = $sb.Clear();
foreach ($item in $searcher.Get()) {
	$path = $item["ExecutablePath"];
	if (-not $path) {
		$path = $item["Name"];
	}
	# Assign to $null is faster than [void] casting or Out-Null
	$null = $sb.Append($item["ProcessId"]).Append($sep).Append([string]$path).Append($sep).Append([string]$item["CommandLine"]).AppendLine();
}
$searcher.Dispose();

[Console]::Write($sb.ToString());
[Console]::WriteLine("${END_MARKER}");

while ($true) {
	$pending = Wait-Event -Timeout 1;

	if (-not $parent -or $parent.HasExited) { break; }
	if (-not $pending) { continue; }

  	$null = $sb.Clear();
  	foreach ($ev in @(Get-Event)) {
		$item = $ev.SourceEventArgs.NewEvent["TargetInstance"];

		if ($ev.SourceIdentifier -eq "start") {
      		$path = $item["ExecutablePath"];
      		if (-not $path) {
        		$path = $item["Name"];
      		}
			# Assign to $null is faster than [void] casting or Out-Null
      		$null = $sb.Append($item["ProcessId"]).Append($sep).Append([string]$path).Append($sep).Append([string]$item["CommandLine"]).AppendLine();
		} else {
			$null = $sb.Append($item["ProcessId"]).AppendLine();
		}
		Remove-Event -EventIdentifier $ev.EventIdentifier;
	}
	if ($sb.Length -gt 0) {
		[Console]::Write($sb.ToString());
	}
}

$startWatcher.Stop();
$stopWatcher.Stop();
`;

let psChild: ChildProcess | null = null;
let stdOutBuffer = "";

let activePromise: Promise<ProcessEntry[]> | null = null;
let resolveActive: ((value: ProcessEntry[]) => void) | null = null;
const currentResults = new Map<number, ProcessEntry>();

// Compiled regex for argument splitting
const ARGS_REGEX = /"([^"]*)"|([^\s"]+)/g;

const ensureProcess = () => {
	if (psChild && !psChild.killed) return;

	log("Spawning background PowerShell process...");

	const scriptBuffer = Buffer.from(PS_SCRIPT, "utf16le");
	const encodedScript = scriptBuffer.toString("base64");

	psChild = spawn(
		"powershell",
		["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedScript],
		{
			stdio: ["ignore", "pipe", "ignore"],
			windowsHide: true,
		},
	);

	psChild.stdout?.setEncoding("utf8");

	psChild.stdout?.on("data", (chunk: string) => {
		stdOutBuffer += chunk;

		const lastNewlineIdx = stdOutBuffer.lastIndexOf("\n");
		if (lastNewlineIdx === -1) return;

		const completeData = stdOutBuffer.substring(0, lastNewlineIdx);
		stdOutBuffer = stdOutBuffer.substring(lastNewlineIdx + 1);

		const lines = completeData.split("\n");
		const len = lines.length;

		let changed = false;
		let ended = false;

		for (let i = 0; i < len; i++) {
			const rawLine = lines[i];

			if (!rawLine || rawLine.length === 0) continue;

			const line = rawLine.trim();
			if (!line) continue;

			if (line === END_MARKER) {
				ended = true;
				continue;
			}

			const p1 = line.indexOf(SEP);
			if (p1 === -1) {
				const pid = parseInt(line, 10);

				if (!Number.isNaN(pid)) {
					currentResults.delete(pid);
					changed = true;
				}
				continue;
			}

			const p2 = line.indexOf(SEP, p1 + 1);

			const pid = parseInt(line.substring(0, p1), 10);

			if (!Number.isNaN(pid)) {
				// Optimized substring extraction (V8 rope)
				const rawPath =
					p2 > -1 ? line.substring(p1 + 1, p2) : line.substring(p1 + 1);
				const cmd = p2 > -1 ? line.substring(p2 + 1) : "";

				const args: string[] = [];
				if (cmd) {
					let argsStr = "";

					// Extract arguments by removing the executable path from the command line
					if (cmd.startsWith(`"${rawPath}"`)) {
						argsStr = cmd.slice(rawPath.length + 2).trim();
					} else if (cmd.startsWith(rawPath)) {
						argsStr = cmd.slice(rawPath.length).trim();
					} else {
						const match = /^("([^"]+)"|([^\s"]+))\s+(.*)$/.exec(cmd);
						if (match) argsStr = match[4] || "";
					}

					if (argsStr) {
						ARGS_REGEX.lastIndex = 0;
						let m: RegExpExecArray | null = ARGS_REGEX.exec(argsStr);
						while (m !== null) {
							args.push(m[1] ?? m[2] ?? "");
							m = ARGS_REGEX.exec(argsStr);
						}
					}
				}

				currentResults.set(pid, [
					pid,
					rawPath.replace(/\\/g, "/"),
					args,
					undefined,
				]);
				changed = true;
			}
		}

		if (resolveActive ? !ended : !changed) return;

		const results = Array.from(currentResults.values());

		if (resolveActive) {
			resolveActive(results);
			resolveActive = null;
		} else {
			activePromise = Promise.resolve(results);
		}
	});

	psChild.on("close", () => {
		psChild = null;
		stdOutBuffer = "";
		currentResults.clear();
		if (resolveActive) {
			resolveActive([]);
			resolveActive = null;
		}
		activePromise = null;
	});
};

export const getProcesses = async (): Promise<ProcessEntry[]> => {
	ensureProcess();

	if (!psChild || psChild.killed) return [];
	if (activePromise) return activePromise;

	activePromise = new Promise((resolve) => {
		resolveActive = resolve;
	});

	return activePromise;
};

const cleanup = () => {
	if (psChild) {
		psChild.kill();
		psChild = null;
	}
};

process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(); });
process.on("SIGTERM", () => { cleanup(); process.exit(); });
process.on("SIGHUP", () => { cleanup(); process.exit(); });