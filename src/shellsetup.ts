import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const MARKER = "# >>> jd >>>";

export type ShellSetupInput = {
    /** $SHELL of the user, e.g. /bin/zsh. */
    shellPath: string | undefined;
    home: string;
    /** $ZDOTDIR, when set. */
    zdotdir?: string;
    platform: NodeJS.Platform;
    /** Shell command that runs this program, already quoted (see shellInit). */
    runCommand: string;
};

export type ShellSetupResult =
    | { status: "installed"; rcFile: string; reload: string }
    | { status: "already-present"; rcFile: string; reload: string }
    | { status: "failed"; reason: string; manual: string };

export function rcFileFor(input: ShellSetupInput): { shell: "zsh" | "bash"; rcFile: string } | null {
    const shell = input.shellPath ? basename(input.shellPath) : "";
    if (shell === "zsh") return { shell, rcFile: join(input.zdotdir || input.home, ".zshrc") };
    if (shell === "bash") {
        // macOS terminals start bash as a login shell, which reads .bash_profile and not .bashrc.
        const profile = join(input.home, ".bash_profile");
        const useProfile = input.platform === "darwin" && (existsSync(profile) || !existsSync(join(input.home, ".bashrc")));
        return { shell, rcFile: useProfile ? profile : join(input.home, ".bashrc") };
    }
    return null;
}

export function initBlock(shell: "zsh" | "bash", runCommand: string): string {
    return `${MARKER} shell function that lets jd change directory, plus tab completion
eval "$(${runCommand} init ${shell})"
# <<< jd <<<`;
}

/**
 * Adds the `jd init` line to the user's shell startup file. Only ever appends, never rewrites,
 * and does nothing when the block is already there.
 */
export function installShellIntegration(input: ShellSetupInput): ShellSetupResult {
    const target = rcFileFor(input);
    const manualFor = (shell: string) => `eval "$(${input.runCommand} init ${shell})"`;
    if (!target) {
        return {
            status: "failed",
            reason: `unsupported shell "${input.shellPath ?? "unknown"}" (supported: zsh, bash)`,
            manual: manualFor("zsh"),
        };
    }
    const reload = target.shell === "zsh" ? "exec zsh" : "exec bash -l";
    try {
        const current = existsSync(target.rcFile) ? readFileSync(target.rcFile, "utf8") : "";
        // Also recognise a hand-written line such as `eval "$(jd init zsh)"`.
        if (current.includes(MARKER) || /(jd|index\.ts)['"]?\s+init\s+(zsh|bash)/.test(current)) return { status: "already-present", rcFile: target.rcFile, reload };
        const separator = current === "" || current.endsWith("\n") ? "" : "\n";
        appendFileSync(target.rcFile, `${separator}${initBlock(target.shell, input.runCommand)}\n`);
        return { status: "installed", rcFile: target.rcFile, reload };
    } catch (error) {
        return {
            status: "failed",
            reason: `could not write ${target.rcFile} (${(error as Error).message})`,
            manual: manualFor(target.shell),
        };
    }
}
