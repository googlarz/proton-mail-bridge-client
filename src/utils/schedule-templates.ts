// Definitions for running `digest` (or `brief`) every day from the operating system's own scheduler. This only builds text: the
// `schedule` command prints it, with the commands to switch it on, and installs nothing by itself.

export type SchedulerSystem = "launchd" | "systemd" | "cron" | "schtasks";

export const SCHEDULER_SYSTEMS: SchedulerSystem[] = ["launchd", "systemd", "cron", "schtasks"];

export interface ScheduleOptions {
  system: SchedulerSystem;
  /** What runs: the digest written to a file (default), or the brief shown as a notification. */
  job?: "digest" | "brief";
  hour: number;
  minute: number;
  /** Absolute path of the Node binary and of this CLI's script: a scheduler's PATH is minimal. */
  node: string;
  script: string;
  /** Where the digest is written. */
  output: string;
  username: string;
  /** A file holding the Bridge password, mode 600. The password itself never goes into a scheduler definition. */
  passwordFile: string;
}

export interface ScheduleOutput {
  /** The file to create, when the system uses one. */
  file?: { path: string; content: string };
  /** Text to show before the steps. */
  body: string;
  /** What to run to switch it on, then off. */
  enable: string[];
  disable: string[];
}

export function parseTimeOfDay(value: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  const hour = match ? Number(match[1]) : Number.NaN;
  const minute = match ? Number(match[2]) : Number.NaN;
  if (!match || hour > 23 || minute > 59) {
    throw new Error(`--at must be a time of day like 08:00 (24-hour), got "${value}".`);
  }
  return { hour, minute };
}

export function defaultSchedulerSystem(platform: NodeJS.Platform): SchedulerSystem {
  if (platform === "darwin") return "launchd";
  if (platform === "win32") return "schtasks";
  return "systemd";
}

const JOB_ARGS = { digest: ["digest"], brief: ["brief", "--sync", "--mark-seen", "--notify"] } as const;
const pad = (value: number) => String(value).padStart(2, "0");
const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// A path or value inside a double-quoted shell or cron word.
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export function buildSchedule(options: ScheduleOptions): ScheduleOutput {
  const { system, hour, minute, node, script, output, username, passwordFile } = options;
  const job = options.job ?? "digest";
  const jobArgs = JOB_ARGS[job];
  const LABEL = `com.proton-mail-bridge-client.${job}`;
  const time = `${pad(hour)}:${pad(minute)}`;

  if (system === "launchd") {
    const path = `~/Library/LaunchAgents/${LABEL}.plist`;
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>${xml(script)}</string>
    ${jobArgs.map((word) => `<string>${word}</string>`).join("\n    ")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PROTONMAIL_USERNAME</key><string>${xml(username)}</string>
    <key>PROTONMAIL_PASSWORD_FILE</key><string>${xml(passwordFile)}</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>${hour}</integer>
    <key>Minute</key><integer>${minute}</integer>
  </dict>
  <key>StandardOutPath</key><string>${xml(output)}</string>
  <key>StandardErrorPath</key><string>${xml(output)}</string>
</dict>
</plist>
`;
    return {
      file: { path, content },
      body: `A launchd job that writes the ${job} to ${output} every day at ${time}.`,
      enable: [`launchctl bootstrap gui/$(id -u) ${path}`],
      disable: [`launchctl bootout gui/$(id -u)/${LABEL}`, `rm ${path}`],
    };
  }

  if (system === "systemd") {
    const dir = "~/.config/systemd/user";
    const service = `[Unit]
Description=Proton Mail ${job}

[Service]
Type=oneshot
Environment=PROTONMAIL_USERNAME=${username}
Environment=PROTONMAIL_PASSWORD_FILE=${passwordFile}
ExecStart=${node} ${script} ${jobArgs.join(" ")}
StandardOutput=file:${output}
StandardError=file:${output}
`;
    const timer = `[Unit]
Description=Proton Mail ${job}, daily

[Timer]
OnCalendar=*-*-* ${time}:00
Persistent=true

[Install]
WantedBy=timers.target
`;
    return {
      file: { path: `${dir}/proton-mail-${job}.timer`, content: timer },
      body: `A systemd user timer (proton-mail-${job}.timer, shown below) that runs this service every day at ${time}.\nAlso create ${dir}/proton-mail-${job}.service:\n\n${service}`,
      enable: ["systemctl --user daemon-reload", "systemctl --user enable --now proton-mail-${job}.timer"],
      disable: ["systemctl --user disable --now proton-mail-${job}.timer"],
    };
  }

  if (system === "cron") {
    const line =
      `${minute} ${hour} * * * PROTONMAIL_USERNAME=${shellQuote(username)} PROTONMAIL_PASSWORD_FILE=${shellQuote(passwordFile)} ` +
      `${shellQuote(node)} ${shellQuote(script)} ${jobArgs.join(" ")} >> ${shellQuote(output)} 2>&1`;
    return {
      body: `A crontab line that appends the ${job} to ${output} every day at ${time}:\n\n${line}`,
      enable: ["crontab -e   # add the line above"],
      disable: ["crontab -e   # remove the line"],
    };
  }

  // schtasks
  const command = `cmd /c "set PROTONMAIL_USERNAME=${username}&& set PROTONMAIL_PASSWORD_FILE=${passwordFile}&& "${node}" "${script}" ${jobArgs.join(" ")} > "${output}" 2>&1"`;
  return {
    body: `A Windows scheduled task that writes the ${job} to ${output} every day at ${time}.`,
    enable: [`schtasks /Create /SC DAILY /ST ${time} /TN "Proton Mail ${job}" /TR '${command}'`],
    disable: [`schtasks /Delete /TN "Proton Mail ${job}" /F`],
  };
}

// A path on the user's PATH that leads to the same file as `target`, if there is one. Homebrew's real Node lives in
// a directory named after its version (.../Cellar/node/26.11.1/bin/node) while /opt/homebrew/bin/node is the link
// that survives an upgrade; a scheduler job should hold the link. Without a match the target itself is used.
export function findStableAlias(options: {
  target: string;
  names: string[];
  dirs: string[];
  realpath: (path: string) => string;
  isExecutable: (path: string) => boolean;
  separator?: string;
}): string | undefined {
  const separator = options.separator ?? "/";
  let targetReal: string;
  try {
    targetReal = options.realpath(options.target);
  } catch {
    return undefined;
  }
  for (const dir of options.dirs) {
    // A relative or empty PATH entry means "the current directory" and would not mean the same thing to a scheduler.
    if (!dir || !(dir.startsWith("/") || /^[A-Za-z]:[\\/]/.test(dir))) continue;
    for (const name of options.names) {
      const candidate = `${dir.replace(/[\\/]+$/, "")}${separator}${name}`;
      try {
        if (options.isExecutable(candidate) && options.realpath(candidate) === targetReal) return candidate;
      } catch {
        // Not there, or not readable: try the next one.
      }
    }
  }
  return undefined;
}
