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

Commit it:

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

When it finishes you'll have a pull request with the feature, new tests, a Codex plan summary and green CI. Review it and merge it yourself.
