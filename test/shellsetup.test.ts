import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { run } from "../src/index";
import { installShellIntegration, rcFileFor, type ShellSetupInput } from "../src/shellsetup";
import { makeDeps, makeTree, mockJev, propertyParameters } from "./helpers";

const input = (home: string, extra: Partial<ShellSetupInput> = {}): ShellSetupInput => ({
    shellPath: "/bin/zsh",
    home,
    platform: "darwin",
    runCommand: "command '/usr/local/bin/jd'",
    ...extra,
});

describe("startup file choice", () => {
    test("zsh uses .zshrc, honouring ZDOTDIR", () => {
        expect(rcFileFor(input("/h"))?.rcFile).toBe("/h/.zshrc");
        expect(rcFileFor(input("/h", { zdotdir: "/z" }))?.rcFile).toBe("/z/.zshrc");
    });

    test("bash uses .bash_profile on macOS (login shells skip .bashrc) and .bashrc on Linux", () => {
        const home = makeTree([]);
        expect(rcFileFor(input(home, { shellPath: "/bin/bash" }))?.rcFile).toBe(join(home, ".bash_profile"));
        expect(rcFileFor(input(home, { shellPath: "/bin/bash", platform: "linux" }))?.rcFile).toBe(join(home, ".bashrc"));
    });
});

describe("installing", () => {
    test("appends one block, keeps existing content, and is idempotent", () => {
        const home = makeTree([]);
        writeFileSync(join(home, ".zshrc"), "export FOO=1"); // no trailing newline

        expect(installShellIntegration(input(home)).status).toBe("installed");
        expect(installShellIntegration(input(home)).status).toBe("already-present");

        const rc = readFileSync(join(home, ".zshrc"), "utf8");
        expect(rc.startsWith("export FOO=1\n# >>> jd >>>")).toBe(true);
        expect(rc.match(/init zsh/g)).toHaveLength(1);
    });

    test("a hand-written init line counts as already set up", () => {
        const home = makeTree([]);
        writeFileSync(join(home, ".zshrc"), 'eval "$(jd init zsh)"\n');
        expect(installShellIntegration(input(home)).status).toBe("already-present");
        expect(readFileSync(join(home, ".zshrc"), "utf8")).toBe('eval "$(jd init zsh)"\n');
    });

    test("unsupported shell and unwritable file fail with the exact line to add", () => {
        const home = makeTree([]);
        const fish = installShellIntegration(input(home, { shellPath: "/usr/bin/fish" }));
        expect(fish).toMatchObject({ status: "failed", manual: `eval "$(command '/usr/local/bin/jd' init zsh)"` });
        expect(existsSync(join(home, ".zshrc"))).toBe(false);

        writeFileSync(join(home, ".zshrc"), "");
        chmodSync(join(home, ".zshrc"), 0o444);
        expect(installShellIntegration(input(home)).status).toBe("failed");
    });

    test("property: existing content is always preserved as a prefix, and a second run changes nothing", () => {
        fc.assert(fc.property(fc.string({ maxLength: 200 }), (existing) => {
            fc.pre(!/init\s+(zsh|bash)/.test(existing) && !existing.includes("# >>> jd >>>"));
            const home = makeTree([]);
            writeFileSync(join(home, ".zshrc"), existing);
            installShellIntegration(input(home));
            const once = readFileSync(join(home, ".zshrc"), "utf8");
            installShellIntegration(input(home));
            expect(once.startsWith(existing)).toBe(true);
            expect(readFileSync(join(home, ".zshrc"), "utf8")).toBe(once);
        }), propertyParameters(40));
    });
});

describe("running without the shell function", () => {
    const shell = (home: string, stdoutIsTTY: boolean) => ({ stdoutIsTTY, shellPath: "/bin/zsh", home, platform: "darwin" as const });

    test("stdout on a terminal: sets up the startup file, navigates nowhere, calls no model", async () => {
        const root = makeTree(["src"]);
        const home = makeTree([]);
        const { model, calls } = mockJev(() => { throw new Error("must not be called"); });
        const deps = makeDeps(root, { model, shell: shell(home, true) });

        const result = await run(["src"], deps);

        expect(result).toEqual({ exitCode: 1, stdout: "" });
        expect(calls).toHaveLength(0);
        expect(readFileSync(join(home, ".zshrc"), "utf8")).toContain("init zsh");
        expect(deps.logs.join("\n")).toContain("exec zsh");
    });

    test("stdout captured (the shell function, or a script): jumps normally and touches no startup file", async () => {
        const root = makeTree(["src"]);
        const home = makeTree([]);
        const result = await run(["src"], makeDeps(root, { shell: shell(home, false) }));

        expect(result.stdout).toBe(join(root, "src"));
        expect(existsSync(join(home, ".zshrc"))).toBe(false);
    });

    test("init without an argument follows $SHELL", async () => {
        const home = makeTree([]);
        const bash = await run(["init"], makeDeps(makeTree([]), { shell: { ...shell(home, true), shellPath: "/opt/homebrew/bin/bash" } }));
        expect(bash.stdout).toContain("complete -o filenames -F _jd jd");
        const zsh = await run(["init"], makeDeps(makeTree([]), { shell: shell(home, true) }));
        expect(zsh.stdout).toContain("compdef _jd jd");
        const fish = await run(["init"], makeDeps(makeTree([]), { shell: { ...shell(home, true), shellPath: "/usr/bin/fish" } }));
        expect(fish.exitCode).toBe(2);
    });

    test("only the $SHELL startup file is ever written", async () => {
        const home = makeTree([]);
        await run(["src"], makeDeps(makeTree(["src"]), { shell: shell(home, true) }));
        expect(existsSync(join(home, ".zshrc"))).toBe(true);
        expect(existsSync(join(home, ".bashrc")) || existsSync(join(home, ".bash_profile"))).toBe(false);
    });

    test("init, --stats and --complete never trigger setup", async () => {
        const home = makeTree([]);
        for (const args of [["init", "zsh"], ["--stats"], ["--complete", "x"], ["--help"]]) {
            await run(args, makeDeps(makeTree([]), { shell: shell(home, true) }));
        }
        expect(existsSync(join(home, ".zshrc"))).toBe(false);
    });
});
