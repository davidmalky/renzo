# Multi-Agent Development Pipeline

Autonomous dev system targeting your Personal Command Center.  
Runs overnight. Pushes to GitHub. Vercel auto-deploys.

---

## Architecture

```
tasks.json  →  Orchestrator
                   ↓
              Researcher    (analyzes current code + task)
                   ↓
              Builder       (writes new code)
                   ↓
              Critic        (reviews, loops back if fail — max 2x)
                   ↓
              Tester        (validates logic)
                   ↓
              UX Agent      (checks UX, blocks deploy if critical issues)
                   ↓
              Deployer      (GitHub push → Vercel auto-deploys)
                   ↓
              logs/         (run report + output HTML saved)
```

---

## One-Time Setup

### 1. Install Python dependencies

```bash
pip install anthropic requests
```

### 2. Get your API keys

**Anthropic API Key:**  
→ https://console.anthropic.com/settings/keys

**GitHub Personal Access Token:**  
→ https://github.com/settings/tokens/new  
→ Scopes needed: `repo` (full)

### 3. Run setup

```bash
python setup.py
```

This creates:
- `.env.json` — your config (gitignored, keep private)
- `run_pipeline.bat` — dry run launcher (Windows double-click)
- `run_pipeline_LIVE.bat` — live deploy launcher

---

## Daily Usage

### Add a task

Edit `tasks.json`. Add an object with `"status": "pending"`:

```json
{
  "id": "personal-os-004",
  "title": "Add a task/todo widget",
  "description": "Detailed description of exactly what you want built. More detail = better output.",
  "priority": "high",
  "status": "pending",
  "project": "personal-os"
}
```

### Run in dry-run mode (review before deploying)

```bash
python run_overnight.py
# or double-click run_pipeline.bat
```

→ Logs saved to `logs/`  
→ Output HTML saved to `logs/output_*.html`  
→ Open the HTML file in browser to preview

### Run live (actually deploys)

```bash
LIVE_DEPLOY=1 python run_overnight.py
# or double-click run_pipeline_LIVE.bat
```

→ Pushes to `davidmalky/personal-os`  
→ Vercel detects push and deploys in ~30 seconds  
→ Live at: https://personal-os-phi-gray.vercel.app

---

## Schedule While You Sleep (Windows Task Scheduler)

1. Open **Task Scheduler** → Create Basic Task
2. **Trigger:** Daily at 11:00 PM
3. **Action:** Start a program
4. **Program/script:** `C:\path\to\agent_pipeline\run_pipeline_LIVE.bat`
5. Save → Done

The pipeline runs at 11 PM, deploys overnight, and your app is updated by morning.

---

## Files

```
agent_pipeline/
├── pipeline.py          ← Core pipeline (all 6 agents)
├── run_overnight.py     ← Batch runner with delay between tasks
├── setup.py             ← One-time setup
├── tasks.json           ← Your task queue
├── README.md            ← This file
├── run_pipeline.bat     ← Generated: Windows dry-run launcher
├── run_pipeline_LIVE.bat← Generated: Windows live launcher
└── logs/
    ├── run_*.json       ← Full run reports (all agent outputs)
    └── output_*.html    ← Generated code files
```

---

## Cost Estimate

| Model | Tokens per run | Cost |
|-------|---------------|------|
| claude-sonnet-4 | ~30K | ~$0.25 |

Monthly (1 task/night): ~$7–8

---

## Extending to Prime Source OS

When ready to target your Work Command Center:

1. Add a task with `"repo": "davidmalky/prime-source-os"`
2. Pipeline code checks `task.get("repo")` and uses it — already wired

Or run a separate `tasks_work.json` + copy of `pipeline.py` with different defaults.

---

## Troubleshooting

**"No module named anthropic"**  
→ `pip install anthropic requests`

**GitHub push fails (403)**  
→ Check token has `repo` scope at github.com/settings/tokens

**Critic keeps failing**  
→ Make task description more specific  
→ Check `logs/run_*.json` for what the critic said

**Output code looks wrong**  
→ Always run dry-run first, review `logs/output_*.html`  
→ Describe the task with more specific constraints
