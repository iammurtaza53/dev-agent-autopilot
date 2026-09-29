# Demo Todo App

A tiny, dependency-free Node project for trying **Dev Agent Autopilot** end to end in about ten minutes.

`NEXT_TASK.md` already contains a small feature request (filtering, removal and a summary). You'll watch Codex plan it, Claude Code build and test it, Codex review it, and a pull request appear with CI running. You do the merge.

## Try it

You need the [requirements](../../README.md#requirements) installed and signed in, and `dev-autopilot` installed.

**1. Copy the demo into its own GitHub repo.**

macOS / Linux:

```bash
cp -r examples/demo-todo-app ~/demo-todo-app
cd ~/demo-todo-app
```

Windows (PowerShell):

```powershell
Copy-Item -Recurse examples\demo-todo-app $HOME\demo-todo-app
cd $HOME\demo-todo-app
```

Then, on any OS:

```bash
git init -b main
git add .
git commit -m "Initial demo"
gh repo create demo-todo-app --private --source . --push
```

**2. Trust the folder in Claude Code once.** Run `claude`, accept the trust prompt, then type `/exit`.

**3. Onboard Autopilot.**

```bash
dev-autopilot init
```

Open `.autopilot/config.json` and set the checks Claude must pass:

```json
"checks": ["npm test"]
```

Commit it, together with the Claude rule and the `.gitignore` entries `init` added:

```bash
git add .
git commit -m "chore: add Dev Agent Autopilot"
git push
```

**4. Launch.**

```bash
dev-autopilot doctor
dev-autopilot run
```

`run` returns right away; the work continues in a Claude Code background session.

**5. Watch it.**

```bash
dev-autopilot status
dev-autopilot agents
```

When it finishes you'll have a pull request with the feature, new tests, a Codex plan and review summary, and green CI. `dev-autopilot efficiency` then shows how much context and check output LeanLoop kept out of the agents' way. With a project this small, most of the saving comes from quiet checks.

Optional: if you installed OpenAI's [Codex plugin for Claude Code](https://github.com/openai/codex-plugin-cc), get a second opinion before merging. Open Claude Code on the PR branch and run `/codex:adversarial-review --base main`. Autopilot doesn't need the plugin; its own review uses the Codex CLI.

**6. Review and merge it yourself.** Autopilot never merges. Replace `OWNER` with your GitHub user:

```bash
gh pr list --repo OWNER/demo-todo-app
gh pr merge <number> --merge --repo OWNER/demo-todo-app
git pull
npm test
```

Leave out `--delete-branch`. The Claude session works in its own Git worktree under `.claude/worktrees/` and may still have the PR branch checked out, so deleting the local branch can fail even though the merge succeeds. Clean up local branches after the session has ended (see the [FAQ](../../README.md#faq)).
