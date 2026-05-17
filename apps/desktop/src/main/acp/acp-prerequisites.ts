import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export type AcpPrerequisiteName = "npx" | "uvx";

export type AcpPrerequisiteStatus =
  | {
      name: AcpPrerequisiteName;
      available: true;
      command: string;
      version?: string;
    }
  | {
      name: AcpPrerequisiteName;
      available: false;
      command: string;
      unavailableReason: string;
    };

export type AcpPrerequisiteProbe = (
  command: string,
  args: string[],
) => Promise<{ stdout?: string; stderr?: string }>;

export async function checkAcpPrerequisite(
  name: AcpPrerequisiteName,
  options: {
    command?: string;
    probe?: AcpPrerequisiteProbe;
  } = {},
): Promise<AcpPrerequisiteStatus> {
  const command = options.command ?? name;
  const probe = options.probe ?? defaultProbe;

  try {
    const result = await probe(command, ["--version"]);
    return {
      name,
      available: true,
      command,
      version: parseVersion(`${result.stdout ?? ""}\n${result.stderr ?? ""}`),
    };
  } catch (error) {
    return {
      name,
      available: false,
      command,
      unavailableReason:
        (error as { code?: unknown })?.code === "ENOENT"
          ? "not-found"
          : error instanceof Error
            ? error.message
            : String(error),
    };
  }
}

async function defaultProbe(
  command: string,
  args: string[],
): Promise<{ stdout?: string; stderr?: string }> {
  return await execFile(command, args, { timeout: 2_000 });
}

function parseVersion(output: string): string | undefined {
  return output.match(/\d+(?:\.\d+){1,3}/)?.[0];
}
