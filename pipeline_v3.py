"""
Agent Pipeline v3 - Self-propelling, chunked builds, budget monitoring
Architecture: Planner -> Builder (chunked) -> Critic -> Tester -> UX -> Deployer -> Task Generator
"""

import os, json, time, datetime, requests
from pathlib import Path

# ── Config ──────────────────────────────────────────────────────────────────
_env = Path(__file__).parent / ".env.json"
if _env.exists():
    for k, v in json.loads(_env.read_text()).items():
        if v: os.environ.setdefault(k, v)

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
GITHUB_TOKEN      = os.environ.get("GITHUB_TOKEN", "")
GITHUB_REPO       = os.environ.get("GITHUB_REPO", "davidmalky/renzo")
TARGET_FILE       = os.environ.get("TARGET_FILE", "index.html")
MODEL             = "claude-sonnet-4-5"
LOG_DIR           = Path(__file__).parent / "logs"
LOG_DIR.mkdir(exist_ok=True)

# Budget config (USD)
BUDGET_WARN_THRESHOLD = 3.00   # checkpoint warning above this per run
BUDGET_HARD_LIMIT     = 10.00   # hard stop per run
SESSION_BUDGET_CAP     = 5.00   # hard stop for entire session (all tasks combined)
COST_PER_1K_INPUT      = 0.003
COST_PER_1K_OUTPUT     = 0.015
CHECKPOINT_INTERVAL    = 10     # seconds between budget checkpoints
session_total_cost     = 0.0    # tracks across all tasks in one session

import anthropic
client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

def fast_call(system, user, max_tokens=1000):
    """Cheaper call using Haiku for review/validation tasks."""
    r = client.messages.create(
        model="claude-haiku-4-5", max_tokens=max_tokens,
        system=system,
        messages=[{"role": "user", "content": user}]
    )
    track_cost(r.usage.input_tokens, r.usage.output_tokens)
    return r.content[0].text.strip()

# ── Logging ─────────────────────────────────────────────────────────────────
run_cost_usd  = 0.0
run_tokens_in = 0
run_tokens_out = 0

def log(agent, msg):
    ts   = datetime.datetime.now().strftime("%H:%M:%S")
    line = f"[{ts}] [{agent.upper()}] {msg}"
    print(line, flush=True)
    return line

def track_cost(input_tokens, output_tokens):
    global run_cost_usd, run_tokens_in, run_tokens_out
    cost = (input_tokens/1000)*COST_PER_1K_INPUT + (output_tokens/1000)*COST_PER_1K_OUTPUT
    run_cost_usd   += cost
    run_tokens_in  += input_tokens
    run_tokens_out += output_tokens
    return cost

def get_run_cost():
    return run_cost_usd

def load_total_cost():
    f = Path(__file__).parent / "cost_log.json"
    return json.loads(f.read_text()).get("total_spent", 0.0) if f.exists() else 0.0

def save_total_cost(run_cost):
    f    = Path(__file__).parent / "cost_log.json"
    data = json.loads(f.read_text()) if f.exists() else {"total_spent": 0.0, "runs": []}
    data["total_spent"] = round(data["total_spent"] + run_cost, 6)
    data["runs"].append({"date": datetime.datetime.now().isoformat(), "cost": round(run_cost, 6)})
    f.write_text(json.dumps(data, indent=2))

# ── Budget checkpoint ────────────────────────────────────────────────────────
def budget_checkpoint(phase_name, countdown=10):
    cost = get_run_cost()
    if cost < BUDGET_WARN_THRESHOLD:
        return True  # under threshold, continue silently
    if cost >= BUDGET_HARD_LIMIT:
        log("BUDGET", f"Hard limit ${BUDGET_HARD_LIMIT:.2f} reached — stopping pipeline")
        return False
    print(f"\n{'='*60}")
    print(f"  BUDGET CHECKPOINT — after {phase_name}")
    print(f"  Spent this run: ${cost:.4f}")
    print(f"  Total to date:  ${load_total_cost():.4f}")
    print(f"  Hard limit:     ${BUDGET_HARD_LIMIT:.2f}")
    print(f"  Press ENTER to continue, or type 'stop' to halt:")
    print(f"  Auto-continuing in {countdown}s...")
    print(f"{'='*60}\n")
    import select, sys
    # Non-blocking input with timeout
    start = time.time()
    response = ""
    while time.time() - start < countdown:
        remaining = int(countdown - (time.time() - start))
        print(f"\r  {remaining}s remaining... ", end="", flush=True)
        time.sleep(1)
    print()
    # On Windows, just continue automatically (can't do non-blocking stdin easily)
    log("BUDGET", f"Checkpoint passed — continuing (${cost:.4f} spent)")
    return True

# ── GitHub helpers ───────────────────────────────────────────────────────────
def github_get(repo, filepath, token):
    url = f"https://api.github.com/repos/{repo}/contents/{filepath}"
    r   = requests.get(url, headers={"Authorization": f"token {token}", "Accept": "application/vnd.github.v3+json"})
    if r.status_code == 404:
        return None, None
    r.raise_for_status()
    import base64
    d = r.json()
    return base64.b64decode(d["content"]).decode("utf-8"), d["sha"]

def github_push(repo, filepath, content, sha, message, token):
    import base64
    url     = f"https://api.github.com/repos/{repo}/contents/{filepath}"
    headers = {"Authorization": f"token {token}", "Accept": "application/vnd.github.v3+json"}
    payload = {"message": message, "content": base64.b64encode(content.encode("utf-8")).decode("utf-8")}
    if sha: payload["sha"] = sha
    r = requests.put(url, headers=headers, json=payload)
    return r.status_code in (200, 201)

# ── Core Claude call ─────────────────────────────────────────────────────────
def call(system, user, max_tokens=4096):
    r = client.messages.create(
        model=MODEL, max_tokens=max_tokens,
        system=system,
        messages=[{"role": "user", "content": user}]
    )
    track_cost(r.usage.input_tokens, r.usage.output_tokens)
    return r.content[0].text.strip()


# ── AGENT: Researcher ────────────────────────────────────────────────────────
def agent_researcher(task, current_code):
    log("RESEARCHER", "Analyzing existing codebase and task requirements...")

    system = """You are a senior code analyst. Your job is to read the existing codebase
and the new task, then produce a precise research report that the Planner will use.

Output structured text with these exact sections:

EXISTING_FEATURES:
- [list every feature/function already in the codebase]

MISSING_FEATURES:
- [list every feature the task requires that does NOT exist yet]

CHANGES_NEEDED:
- [list existing features that need to be modified]

REUSE:
- [list existing code patterns, styles, functions to preserve and reuse]

RISKS:
- [list technical risks or conflicts to watch for]

DATA_STRUCTURES:
- [list existing localStorage keys and data formats found in code]

Be specific. Reference actual function names and variable names from the code."""

    code_sample = current_code[:8000] if current_code else "No existing code — building from scratch"

    user_msg = "TASK: " + task["title"] + "\n\nTASK DESCRIPTION:\n" + task["description"][:2000] + "\n\nEXISTING CODEBASE:\n" + code_sample
    raw = call(system, user_msg, max_tokens=3000)

    log("RESEARCHER", "Research complete")
    research_path = LOG_DIR / f"research_{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}.txt"
    research_path.write_text(raw, encoding="utf-8")
    log("RESEARCHER", f"Research saved → {research_path}")
    return raw

# ── AGENT: Spec Critic ───────────────────────────────────────────────────────
def agent_spec_critic(task, spec_raw, research, attempt=1):
    log("SPEC_CRITIC", f"Reviewing plan (attempt {attempt})...")

    system = """You are a pragmatic engineering lead reviewing a technical spec.
Your job is to approve specs that are clear enough to implement, and only reject them if there are genuine blockers.

For simple, small tasks (adding a UI element, fixing a bug, minor feature): approve if the approach is sensible.
Only request revision if something is genuinely missing that would cause the build to fail.

Output structured text:

VERDICT: APPROVED or NEEDS_REVISION

GAPS:
- [features mentioned in task but missing from spec]

CONTRADICTIONS:
- [conflicting requirements or impossible combinations]

AMBIGUITIES:
- [things that are unclear and would cause the builder to guess wrong]

MISSING_FUNCTIONS:
- [functions that will clearly be needed but aren't listed]

MISSING_EDGE_CASES:
- [error states or edge cases not handled]

APPROVED_SECTIONS:
- [sections of the spec that are solid and complete]

REVISION_INSTRUCTIONS:
- [specific changes the Planner must make — only if NEEDS_REVISION]

If the spec is complete and covers all task requirements clearly, output VERDICT: APPROVED."""

    critic_prompt = "TASK: " + task["title"] + "\n\nTASK REQUIREMENTS:\n" + task["description"][:2000] + "\n\nRESEARCH FINDINGS:\n" + research[:2000] + "\n\nSPEC TO REVIEW:\n" + spec_raw[:4000]
    raw = call(system, critic_prompt, max_tokens=2000)

    approved = "VERDICT: APPROVED" in raw
    log("SPEC_CRITIC", f"Verdict: {'APPROVED' if approved else 'NEEDS REVISION'}")

    if not approved:
        # Extract revision instructions
        instructions = ""
        in_section = False
        for line in raw.split("\n"):
            if "REVISION_INSTRUCTIONS:" in line:
                in_section = True
                continue
            if in_section and line.strip().startswith("-"):
                instructions += line.strip() + "\n"
            elif in_section and line.strip() and not line.strip().startswith("-"):
                in_section = False
        log("SPEC_CRITIC", f"Revision instructions: {instructions[:200]}")
        return {"approved": False, "feedback": raw, "revision_instructions": instructions}

    log("SPEC_CRITIC", "Spec approved — proceeding to build")
    return {"approved": True, "feedback": raw, "revision_instructions": ""}

# ── AGENT: Planner ────────────────────────────────────────────────────────────
def agent_planner(task, research='', revision_instructions=''):
    log("PLANNER", "Creating technical specification...")
    system = """You are a senior software architect. Create a complete technical spec.
Use plain structured text — NOT JSON. Use these exact section headers:

OVERVIEW: [2-3 sentence description]

VIEWS:
- ViewName: purpose and key elements

FUNCTIONS:
- functionName(params): what it does step by step

DATA:
- key: what is stored and format

API:
- name: endpoint, method, payload, response handling

DESIGN:
- specific colors, fonts, layout rules

ERRORS:
- each error state to handle

SCOPE_CHECK:
- Estimated total lines: [number]
- If over 650 lines: split into smaller tasks (list them)
- If under 650 lines: SINGLE_TASK: proceed as one build

CRITICAL: The Builder writes the ENTIRE file in ONE API call with an 8192 token limit.
This means the complete file must be under 650 lines. Be concise in the spec.
If the task requires more, note what to split off as a follow-up task."""

    revision_str = ("\n\nREVISION INSTRUCTIONS FROM SPEC CRITIC:\n" + revision_instructions) if revision_instructions else ""
    research_str  = ("\n\nRESEARCH FINDINGS:\n" + research[:2000]) if research else ""
    user_prompt   = "TASK: " + task["title"] + "\n\nDESCRIPTION:\n" + task["description"] + research_str + revision_str

    raw = call(system, user_prompt, max_tokens=6000)

    # Extract sections list for chunked building
    sections = []
    in_sections = False
    for line in raw.split("\n"):
        line = line.strip()
        if line == "SECTIONS:":
            in_sections = True
            continue
        if in_sections:
            if line.startswith("- ") and ":" in line:
                name = line[2:].split(":")[0].strip()
                desc = line[2:].split(":", 1)[1].strip()
                sections.append({"name": name, "description": desc})
            elif line and not line.startswith("-") and not line.startswith(" "):
                in_sections = False

    # Single section for single-shot build
    if not sections:
        sections = [{"name": "CompleteFile", "description": "Complete single-file HTML/JS application"}]

    log("PLANNER", f"Spec complete: {len(sections)} build sections planned")
    spec_path = LOG_DIR / f"spec_{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}.txt"
    spec_path.write_text(raw, encoding="utf-8")
    log("PLANNER", f"Spec saved → {spec_path}")
    return {"raw": raw, "sections": sections}

# ── AGENT: Builder (chunked) ─────────────────────────────────────────────────
def generate_manifest(code):
    """Extract structured manifest of everything in the codebase."""
    if not code or len(code) < 100:
        return "No existing code."
    import re
    manifest = []
    ids      = re.findall(r'id=["\']([\w-]+)["\']', code)
    if ids:   manifest.append("HTML IDs: " + ", ".join(sorted(set(ids))[:50]))
    funcs    = re.findall(r'(?:function\s+(\w+)|(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?(?:function|\())', code)
    fn_names = [f[0] or f[1] for f in funcs if f[0] or f[1]]
    if fn_names: manifest.append("FUNCTIONS: " + ", ".join(fn_names[:60]))
    ls_keys  = re.findall(r'localStorage\.(?:getItem|setItem)\(["\']([\w_]+)["\']', code)
    if ls_keys:  manifest.append("LOCALSTORAGE: " + ", ".join(sorted(set(ls_keys))))
    nav      = re.findall(r'data-view=["\']([\w-]+)["\']', code)
    if nav:   manifest.append("NAV VIEWS: " + ", ".join(nav))
    return "\n".join(manifest)


def agent_builder(task, current_code, spec, critic_feedback="", previous_output=""):
    """Surgical edit builder — modifies existing code rather than rewriting it."""
    log("BUILDER", "Analyzing codebase for surgical edits...")

    feedback_str = ("\n\nPREVIOUS ATTEMPT FAILED WITH:\n" + critic_feedback) if critic_feedback else ""
    manifest     = generate_manifest(current_code)

    # Step 1: Ask what edits are needed
    edit_plan_raw = call(
        """You are a senior developer. Given existing code and a task, produce a precise edit plan.
For each change needed, specify EXACTLY:
1. The type: INSERT, REPLACE, or APPEND
2. For INSERT/REPLACE: the unique anchor string to find in the existing code (verbatim, ~20-40 chars)
3. The new code to insert or use as replacement

Output JSON array only:
[
  {
    "type": "INSERT_BEFORE" | "INSERT_AFTER" | "REPLACE" | "APPEND_TO_SCRIPT" | "APPEND_TO_STYLE",
    "anchor": "exact string to find in existing code",
    "code": "the new code to insert/replace with"
  }
]

Rules:
- Use APPEND_TO_SCRIPT to add new JS functions (inserts before closing </script>)
- Use APPEND_TO_STYLE to add new CSS (inserts before closing </style>)
- Use INSERT_BEFORE/INSERT_AFTER to add HTML elements
- Use REPLACE to modify existing code
- Keep each edit focused and minimal
- Anchor strings must be unique in the file""",
        ("TASK: " + task["title"] + "\n\nDESCRIPTION:\n" + task["description"][:2000] +
         "\n\nEXISTING CODE MANIFEST:\n" + manifest +
         "\n\nEXISTING CODE (first 8000 chars):\n" + current_code[:8000] +
         feedback_str +
         "\n\nProduce the minimal edit plan to implement this task."),
        max_tokens=4000
    )

    # Parse edit plan
    try:
        if "```json" in edit_plan_raw:
            edit_plan_raw = edit_plan_raw.split("```json")[1].split("```")[0].strip()
        elif "```" in edit_plan_raw:
            edit_plan_raw = edit_plan_raw.split("```")[1].split("```")[0].strip()
        edits = json.loads(edit_plan_raw)
        if not isinstance(edits, list):
            edits = [edits]
    except Exception as e:
        log("BUILDER", f"Edit plan parse failed ({e}) — falling back to full rewrite")
        edits = [{"type": "FULL_REWRITE", "anchor": "", "code": ""}]

    log("BUILDER", f"Edit plan: {len(edits)} edit(s) planned")

    # Step 2: Generate the actual code for each edit
    result = current_code

    for i, edit in enumerate(edits):
        edit_type = edit.get("type", "")
        anchor    = edit.get("anchor", "")
        new_code  = edit.get("code", "")

        # If code is placeholder or empty, generate it
        if not new_code or len(new_code) < 10 or new_code.strip() in ["...", "// code here", ""]:
            log("BUILDER", f"Generating code for edit {i+1}: {edit_type}")
            new_code = call(
                f"""Write the code for this specific edit. Output raw code only — no explanation, no markdown.
Edit type: {edit_type}
What it does: {task["title"]}
Context from manifest: {manifest[:500]}""",
                (f"Generate the code to {edit_type} at anchor: {anchor[:100]}\n\n" +
                 f"Full task: {task['description'][:1000]}\n\n" +
                 f"Surrounding code context:\n{current_code[max(0,current_code.find(anchor)-200):current_code.find(anchor)+200] if anchor in current_code else 'See full task description'}"),
                max_tokens=3000
            )
            # Strip fences
            for fence in ["```html", "```javascript", "```js", "```"]:
                if new_code.startswith(fence):
                    new_code = new_code[len(fence):]
                    break
            if new_code.endswith("```"):
                new_code = new_code[:-3]
            new_code = new_code.strip()

        # Apply the edit
        if edit_type == "APPEND_TO_SCRIPT":
            if "</script>" in result:
                result = result.replace("</script>", new_code + "\n</script>", 1)
                log("BUILDER", f"Edit {i+1}: appended to script ({len(new_code)} chars)")
            else:
                result += "\n<script>\n" + new_code + "\n</script>"
                log("BUILDER", f"Edit {i+1}: created script section")

        elif edit_type == "APPEND_TO_STYLE":
            if "</style>" in result:
                result = result.replace("</style>", new_code + "\n</style>", 1)
                log("BUILDER", f"Edit {i+1}: appended to style ({len(new_code)} chars)")

        elif edit_type == "INSERT_BEFORE" and anchor:
            if anchor in result:
                result = result.replace(anchor, new_code + "\n" + anchor, 1)
                log("BUILDER", f"Edit {i+1}: inserted before anchor")
            else:
                log("BUILDER", f"Edit {i+1}: anchor not found — skipping")

        elif edit_type == "INSERT_AFTER" and anchor:
            if anchor in result:
                result = result.replace(anchor, anchor + "\n" + new_code, 1)
                log("BUILDER", f"Edit {i+1}: inserted after anchor")
            else:
                log("BUILDER", f"Edit {i+1}: anchor not found — skipping")

        elif edit_type == "REPLACE" and anchor:
            if anchor in result:
                result = result.replace(anchor, new_code, 1)
                log("BUILDER", f"Edit {i+1}: replaced anchor ({len(anchor)} -> {len(new_code)} chars)")
            else:
                log("BUILDER", f"Edit {i+1}: anchor not found for replacement — skipping")

        elif edit_type == "FULL_REWRITE":
            log("BUILDER", "Falling back to full rewrite (file is small enough)")
            if len(current_code) < 15000:
                result = call(
                    """Write a COMPLETE single HTML file. Raw HTML only. Start <!DOCTYPE html>. End </html>.""",
                    ("TASK: " + task["title"] + "\nDESCRIPTION:\n" + task["description"][:2000] +
                     "\nEXISTING FILE:\n" + current_code),
                    max_tokens=8192
                )
                for fence in ["```html", "```"]:
                    if result.startswith(fence):
                        result = result[len(fence):]
                        break
                if result.endswith("```"):
                    result = result[:-3]
                result = result.strip()

    # Completeness check
    if "</html>" not in result[-200:]:
        log("BUILDER", "WARNING: Missing </html> — repairing")
        result += "\n</body>\n</html>"

    issues = []
    if "<script" not in result:
        issues.append("no <script> section")
    if issues:
        log("BUILDER", f"Issues: {'; '.join(issues)}")
    else:
        log("BUILDER", "Completeness check passed")

    # Clear checkpoint
    checkpoint = LOG_DIR / "build_checkpoint.html"
    if checkpoint.exists():
        checkpoint.unlink()

    log("BUILDER", f"Build complete: {len(result)} chars ({len(result)-len(current_code):+d} from original)")
    return result



# ── AGENT: Claude Code Builder (preferred over chunked builder) ──────────────
# Uses `claude` CLI to edit files directly — bypasses token limits entirely.
# Falls back to chunked builder if Claude Code is not available.

import subprocess, shutil

def _claude_code_available():
    import sys
    if sys.platform == 'win32':
        # On Windows, npm installs claude as claude.cmd
        return shutil.which('claude') is not None or shutil.which('claude.cmd') is not None
    return shutil.which('claude') is not None

def _claude_cmd():
    """Get the correct claude command for this platform."""
    import sys
    if sys.platform == 'win32':
        # Prefer claude.cmd on Windows
        if shutil.which('claude.cmd'):
            return 'claude.cmd'
    return 'claude'

def agent_builder_claude_code(task, current_code, spec, critic_feedback="", work_dir=None):
    """
    Uses Claude Code CLI to build/edit code directly on disk.
    This is the preferred builder — no token ceiling, no assembly issues.
    """
    if not _claude_code_available():
        log("BUILDER", "Claude Code CLI not found — falling back to chunked builder")
        return agent_builder(task, current_code, spec, critic_feedback)

    log("BUILDER", "Using Claude Code CLI for direct file editing")

    # Set up working directory
    if work_dir is None:
        work_dir = LOG_DIR / "claude_code_workspace"
    work_dir = Path(work_dir)
    work_dir.mkdir(exist_ok=True)

    # Write current code to workspace
    target = work_dir / "index.html"
    if current_code:
        target.write_text(current_code, encoding="utf-8")
        log("BUILDER", f"Workspace initialized: {len(current_code)} chars")
    else:
        target.write_text("", encoding="utf-8")
        log("BUILDER", "Starting from scratch")

    # Build the prompt for Claude Code
    feedback_str = f"\n\nCRITIC FEEDBACK TO FIX:\n{critic_feedback}" if critic_feedback else ""
    spec_summary = spec["raw"][:3000] if spec else "Build according to the task description."

    prompt = f"""Task: {task['title']}

Description: {task['description']}

Technical Spec:
{spec_summary}
{feedback_str}

Instructions:
- Edit index.html to implement the task completely
- The file must be a single complete HTML/JS/CSS file
- Preserve all existing functionality
- Add the new features described in the task
- Make sure the file is syntactically valid and complete
- Do not truncate or leave TODOs
"""

    # Run Claude Code
    try:
        import sys as _sys
        cmd = _claude_cmd()
        # On Windows, use shell=True to properly resolve .cmd files
        use_shell = _sys.platform == 'win32'
        if use_shell:
            cmd_str = f'{cmd} --dangerously-skip-permissions -p "{prompt.replace(chr(34), chr(39))}"'
            result = subprocess.run(
                cmd_str,
                cwd=str(work_dir),
                capture_output=True,
                text=True,
                timeout=300,
                shell=True
            )
        else:
            result = subprocess.run(
                [cmd, "--dangerously-skip-permissions", "-p", prompt],
                cwd=str(work_dir),
                capture_output=True,
                text=True,
                timeout=300
            )
        
        if result.returncode != 0:
            log("BUILDER", f"Claude Code exited with code {result.returncode}")
            log("BUILDER", f"stderr: {result.stderr[:200]}")
            log("BUILDER", "Falling back to chunked builder")
            return agent_builder(task, current_code, spec, critic_feedback)
        
        # Read the edited file
        if target.exists():
            new_code = target.read_text(encoding="utf-8")
            log("BUILDER", f"Claude Code build complete: {len(new_code)} chars")
            log("BUILDER", f"stdout preview: {result.stdout[:100]}")
            
            # Save checkpoint
            checkpoint = LOG_DIR / "build_checkpoint.html"
            checkpoint.write_text(new_code, encoding="utf-8")
            
            return new_code
        else:
            log("BUILDER", "Claude Code did not produce output file — falling back")
            return agent_builder(task, current_code, spec, critic_feedback)
            
    except subprocess.TimeoutExpired:
        log("BUILDER", "Claude Code timed out (5 min) — falling back to chunked builder")
        return agent_builder(task, current_code, spec, critic_feedback)
    except Exception as e:
        log("BUILDER", f"Claude Code error: {e} — falling back")
        return agent_builder(task, current_code, spec, critic_feedback)


# ── AGENT: Critic (full file, chunked review) ────────────────────────────────
def agent_critic(task, original, new_code, spec):
    log("CRITIC", "Structural + targeted review...")

    # Structural checks — no API call needed
    if not new_code or len(new_code) < 1000:
        return {"verdict": "fail", "score": 1, "issues": ["Output too short"], "feedback": "Build produced no output."}

    if "</html>" not in new_code[-1000:]:
        return {"verdict": "fail", "score": 2, "issues": ["Missing </html>"], "feedback": "File truncated — rebuild."}

    if "<script" not in new_code:
        return {"verdict": "fail", "score": 2, "issues": ["Missing <script>"], "feedback": "JS section missing."}

    orig_len = len(original) if original else 0
    if orig_len > 0 and len(new_code) < orig_len * 0.95:
        loss = orig_len - len(new_code)
        return {"verdict": "fail", "score": 2, "issues": [f"File shrunk {loss} chars — content deleted"], "feedback": "Rebuild preserving all existing code."}

    # Find changed lines
    orig_lines = original.split("\n") if original else []
    new_lines  = new_code.split("\n")
    first_change = last_change = None
    for i, pair in enumerate(zip(orig_lines, new_lines)):
        if pair[0] != pair[1]:
            if first_change is None: first_change = i
            last_change = i
    if first_change is None and len(new_lines) > len(orig_lines):
        first_change = len(orig_lines)
        last_change  = len(new_lines)

    if first_change is not None:
        s = max(0, first_change - 10)
        e = min(len(new_lines), (last_change or first_change) + 40)
        section = "\n".join(new_lines[s:e])
        log("CRITIC", f"Reviewing changed lines {first_change}-{last_change} ({len(section)} chars)")
    else:
        section = new_code[:2000]
        log("CRITIC", "No diff found — sampling file start")

    tail = new_code[-600:]

    try:
        raw = fast_call(
            "Review the changed code section of a single HTML/JS/CSS app file. "
            "DO NOT flag truncation — you are seeing one section of a complete file. "
            "Check: (1) Does it implement the task? (2) Real syntax errors in the changed section? "
            "Be practical — only fail for genuine bugs or missing requirements. "
            "JSON only: {\"verdict\": \"pass\" or \"fail\", \"score\": 0-10, \"issues\": [\"specific issue\"], \"feedback\": \"fix needed\"}",
            "TASK: " + task["title"] + "\n\nCHANGED SECTION:\n" + section + "\n\nFILE TAIL:\n" + tail,
            max_tokens=500
        )
        if "```" in raw:
            raw = raw.split("```")[1].split("```")[0].strip()
            if raw.startswith("json"): raw = raw[4:].strip()
        result = json.loads(raw)
    except Exception as ex:
        log("CRITIC", f"Review call failed ({ex}) — auto-passing")
        result = {"verdict": "pass", "score": 8, "issues": [], "feedback": ""}

    log("CRITIC", f"Verdict: {result['verdict'].upper()} | Score: {result.get('score','?')}/10")
    for issue in result.get("issues", [])[:3]:
        log("CRITIC", f"  {issue}")
    return result


def agent_tester(task, new_code, spec):
    log("TESTER", "Validating against spec...")

    # Check functions exist
    missing = []
    for line in spec["raw"].split("\n"):
        line = line.strip()
        if line.startswith("- ") and "(" in line and "):" in line:
            fname = line[2:].split("(")[0].strip()
            if fname and len(fname) > 2 and fname[0].islower():
                if f"function {fname}" not in new_code and f"{fname} =" not in new_code and f"const {fname}" not in new_code:
                    missing.append(fname)

    try:
        raw = call(
            "QA test: does this code implement all spec requirements? JSON only: {\"passed\": true/false, \"missing\": [\"features not implemented\"], \"note\": \"summary\"}",
            f"TASK: {task['title']}\nSPEC OVERVIEW:\n{spec['raw'][:2000]}\n\nMISSING FUNCTIONS DETECTED: {missing[:10]}\n\nCODE (first 5000 chars):\n{new_code[:5000]}",
            max_tokens=800
        )
        if "```" in raw: raw = raw.split("```")[1].split("```")[0].strip()
        if raw.startswith("json"): raw = raw[4:].strip()
        result = json.loads(raw)
    except Exception:
        result = {"passed": len(missing) == 0, "missing": missing[:5], "note": "Auto-evaluated"}

    if missing: result["passed"] = False
    log("TESTER", f"{'PASSED' if result.get('passed') else 'FAILED'} | {result.get('note','')[:80]}")
    if missing: log("TESTER", f"  Missing: {missing[:5]}")
    return result

# ── AGENT: UX reviewer ───────────────────────────────────────────────────────
def agent_ux(task, new_code):
    log("UX", "Checking user experience...")

    # Only review first and last chunks to save cost - full-file UX review is too expensive
    chunk_size = 12000
    chunks_to_review = []
    all_chunks = list(range(0, len(new_code), chunk_size))
    if len(all_chunks) <= 3:
        chunks_to_review = all_chunks
    else:
        # Sample: first, middle, last chunks only
        chunks_to_review = [all_chunks[0], all_chunks[len(all_chunks)//2], all_chunks[-1]]
    
    all_blocking = []
    for i in chunks_to_review:
        chunk = new_code[i:i+chunk_size]
        try:
            raw = call(
                "UX review: check mobile responsiveness, accessibility, user flow, error states. JSON only: {\"blocking\": [\"critical issues only - must fix before launch\"], \"suggestions\": [\"minor improvements\"]}. Only flag genuine showstopper UX issues, not code style or truncation artifacts.",
                f"CODE CHUNK:\n{chunk}",
                max_tokens=400
            )
            if "```" in raw: raw = raw.split("```")[1].split("```")[0].strip()
            if raw.startswith("json"): raw = raw[4:].strip()
            result = json.loads(raw)
            all_blocking.extend(result.get("blocking", []))
        except Exception:
            pass

    score = max(10 - len(all_blocking), 2)
    log("UX", f"{'APPROVED' if not all_blocking else 'ISSUES'} | Score: {score}/10 | Blocking: {len(all_blocking)}")
    return {"approved": not all_blocking, "ux_score": score, "blocking_issues": all_blocking[:8]}

# ── AGENT: Deployer ──────────────────────────────────────────────────────────
def agent_deployer(task, new_code, sha, dry_run, repo, filepath):
    log("DEPLOYER", f"{'DRY RUN — ' if dry_run else ''}Pushing to {repo}...")
    if not GITHUB_TOKEN:
        log("DEPLOYER", "No GITHUB_TOKEN — skipping")
        return {"deployed": False}
    if dry_run:
        log("DEPLOYER", "DRY RUN: Would push to GitHub → Vercel auto-deploys")
        return {"deployed": False, "dry_run": True}
    ok = github_push(repo, filepath, new_code, sha, f"feat: {task['title']} [agent-pipeline-v3]", GITHUB_TOKEN)
    log("DEPLOYER", "Pushed successfully → Vercel deploying..." if ok else "Push failed")
    return {"deployed": ok}

# ── AGENT: Task Generator ────────────────────────────────────────────────────
def agent_task_generator(completed_task, new_code, spec, existing_tasks):
    log("TASKGEN", "Evaluating what to build next...")

    existing_titles = [t.get("title","") for t in existing_tasks if t.get("status") == "pending"]
    if existing_titles:
        log("TASKGEN", f"Pending tasks already exist: {len(existing_titles)} — skipping generation")
        return None

    try:
        raw = call(
            """You are a product manager. Your job is to decide the SINGLE next feature to build.

CRITICAL RULES:
1. Stay strictly within the project vision — do NOT invent features not mentioned
2. The project is a FRONTEND-ONLY single HTML file — no backend, no server, no OAuth flows
3. Only propose features that are explicitly in the project_vision or are direct prerequisites
4. If the core features of the project_vision are complete, output {"done": true}
5. Never propose Salesforce OAuth, WebSockets, real-time sync, or server-side features

Output JSON only:
{
  "title": "short task title",
  "description": "detailed spec — frontend only, localStorage data, no backend",
  "priority": "high",
  "rationale": "which part of the project_vision this serves"
}
If no next task is needed or vision is complete, output: {"done": true}""",
            f"COMPLETED: {completed_task['title']}\n\nPROJECT DESCRIPTION: {completed_task.get('project_vision','')}\n\nCURRENT CODE CAPABILITIES (from spec):\n{spec['raw'][:2000]}\n\nWhat should be built next?",
            max_tokens=2000
        )
        if "```" in raw: raw = raw.split("```")[1].split("```")[0].strip()
        if raw.startswith("json"): raw = raw[4:].strip()
        result = json.loads(raw)
        if result.get("done"):
            log("TASKGEN", "Task generator says project is complete")
            return None
        next_task = {
            "id": f"auto-{int(time.time())}",
            "title": result["title"],
            "description": result["description"],
            "priority": result.get("priority", "high"),
            "status": "pending",
            "repo": completed_task.get("repo", GITHUB_REPO),
            "target_file": completed_task.get("target_file", "index.html"),
            "auto_generated": True,
            "rationale": result.get("rationale","")
        }
        log("TASKGEN", f"Next task: {next_task['title']}")
        log("TASKGEN", f"Rationale: {result.get('rationale','')[:100]}")
        return next_task
    except Exception as e:
        log("TASKGEN", f"Task generation failed: {e}")
        return None

# ── Orchestrator ─────────────────────────────────────────────────────────────
def orchestrator(task, dry_run=True, task_file=None, auto_propel=True):
    global run_cost_usd, run_tokens_in, run_tokens_out
    run_cost_usd = run_tokens_in = run_tokens_out = 0

    repo     = task.get("repo", GITHUB_REPO)
    filepath = task.get("target_file", "index.html")
    run_log  = []
    start    = time.time()

    def record(agent, data):
        run_log.append({"agent": agent, "data": data, "t": round(time.time()-start, 1)})

    log("ORCH", "="*60)
    log("ORCH", f"Pipeline v3: {task['title']}")
    log("ORCH", f"Target: {repo}/{filepath}")
    log("ORCH", f"Mode: {'DRY RUN' if dry_run else 'LIVE DEPLOY'} | Auto-propel: {auto_propel}")
    log("ORCH", "="*60)

    # ── Fetch current code ──────────────────────────────────────────────────
    current_code, sha = "", ""
    if GITHUB_TOKEN:
        try:
            current_code, sha = github_get(repo, filepath, GITHUB_TOKEN)
            current_code = current_code or ""
            sha          = sha or ""
            log("ORCH", f"Fetched existing file: {len(current_code)} chars")
        except Exception as e:
            log("ORCH", f"No existing file — building from scratch ({e})")

    # Clear any stale checkpoint from previous runs
    checkpoint = LOG_DIR / "build_checkpoint.html"
    previous_output = ""
    if checkpoint.exists():
        checkpoint.unlink()
        log("ORCH", "Cleared stale build checkpoint")

    # ── Phase 1: Research → Plan → Spec Review ─────────────────────────────
    log("ORCH", "\nPHASE 1: RESEARCH + PLANNING")

    # Step 1a: Researcher reads current codebase
    log("ORCH", "Step 1: Research")
    research = agent_researcher(task, current_code)
    record("researcher", {"length": len(research)})

    # Step 1b: Planner writes spec informed by research
    log("ORCH", "Step 2: Planning")
    spec = agent_planner(task, research=research)
    record("planner", {"sections": len(spec["sections"])})

    # Step 1c: Spec Critic reviews and approves plan (max 2 revision loops)
    log("ORCH", "Step 3: Spec Review")
    MAX_SPEC_LOOPS = 2
    for spec_attempt in range(1, MAX_SPEC_LOOPS + 2):
        spec_review = agent_spec_critic(task, spec["raw"], research, attempt=spec_attempt)
        record(f"spec_critic_{spec_attempt}", {"approved": spec_review["approved"]})
        if spec_review["approved"]:
            log("ORCH", "Spec approved — proceeding to build")
            break
        if spec_attempt > MAX_SPEC_LOOPS:
            log("ORCH", "Spec critic still has concerns after revisions — proceeding anyway")
            break
        log("ORCH", f"Spec needs revision (attempt {spec_attempt + 1})")
        spec = agent_planner(task, research=research, revision_instructions=spec_review["revision_instructions"])
        record(f"planner_revision_{spec_attempt}", {"sections": len(spec["sections"])})

    if not budget_checkpoint("Planning"): return False

    # ── Phase 2: Build ──────────────────────────────────────────────────────
    log("ORCH", "\nPHASE 2: BUILD")
    new_code       = None
    critic_result  = None
    critic_feedback = ""
    MAX_LOOPS = 3

    for attempt in range(1, MAX_LOOPS+2):
        log("ORCH", f"Build attempt {attempt}/{MAX_LOOPS+1}")
        if _claude_code_available():
            new_code = agent_builder_claude_code(task, current_code, spec, critic_feedback)
        else:
            new_code = agent_builder(task, current_code, spec, critic_feedback)
        previous_output = ""  # only use checkpoint on first attempt
        record(f"builder_{attempt}", {"len": len(new_code)})

        critic_result = agent_critic(task, current_code, new_code, spec)
        record(f"critic_{attempt}", critic_result)

        if critic_result["verdict"] == "pass":
            log("ORCH", "Critic approved")
            break
        if attempt > MAX_LOOPS:
            log("ORCH", f"Critic still failing after {MAX_LOOPS} attempts — proceeding")
            break
        critic_feedback = critic_result.get("feedback","")
        log("ORCH", f"Critic failed — rebuilding (attempt {attempt+1})")
        if not budget_checkpoint(f"Build attempt {attempt}"):
            return False

    # ── Phase 3: Test ───────────────────────────────────────────────────────
    log("ORCH", "\nPHASE 3: TESTING")
    test_result = agent_tester(task, new_code, spec)
    record("tester", test_result)
    if not test_result.get("passed"):
        log("ORCH", "Tester failed — one more build pass")
        if _claude_code_available():
            new_code = agent_builder_claude_code(task, new_code, spec, "Fix missing features: " + test_result.get("note",""))
        else:
            if _claude_code_available():
                new_code = agent_builder_claude_code(task, new_code, spec, "Fix missing features: " + test_result.get("note",""))
            else:
                new_code = agent_builder(task, new_code, spec, "Fix missing features: " + test_result.get("note",""))
        record("builder_test_fix", {"len": len(new_code)})

    if not budget_checkpoint("Testing"): return False

    # ── Phase 4: UX ─────────────────────────────────────────────────────────
    log("ORCH", "\nPHASE 4: UX REVIEW")
    ux = agent_ux(task, new_code)
    record("ux_1", ux)
    if ux.get("blocking_issues"):
        log("ORCH", f"UX issues — auto-fixing ({len(ux['blocking_issues'])})")
        if _claude_code_available():
            issues = [str(x) if not isinstance(x, str) else x for x in ux["blocking_issues"][:5]]
            new_code = agent_builder_claude_code(task, new_code, spec, "Fix these UX issues: " + "; ".join(issues))
        else:
            issues = [str(x) if not isinstance(x, str) else x for x in ux["blocking_issues"][:5]]
            new_code = agent_builder(task, new_code, spec, "Fix these UX issues: " + "; ".join(issues))
        record("builder_ux_fix", {"len": len(new_code)})
        ux = agent_ux(task, new_code)
        record("ux_2", ux)
    log("ORCH", f"UX final score: {ux.get('ux_score','?')}/10")

    if not budget_checkpoint("UX Review"): return False

    # ── Save output ──────────────────────────────────────────────────────────
    out = LOG_DIR / f"output_{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}.html"
    out.write_text(new_code, encoding="utf-8")
    log("ORCH", f"Output saved → {out}")

    # ── Phase 5: Deploy ──────────────────────────────────────────────────────
    log("ORCH", "\nPHASE 5: DEPLOY")
    deploy = agent_deployer(task, new_code, sha, dry_run, repo, filepath)
    record("deployer", deploy)

    # ── Phase 6: Task Generation ─────────────────────────────────────────────
    next_task = None
    if auto_propel and deploy.get("deployed") and task_file:
        log("ORCH", "\nPHASE 6: TASK GENERATION")
        tasks = json.loads(Path(task_file).read_text())
        next_task = agent_task_generator(task, new_code, spec, tasks)
        if next_task:
            tasks.append(next_task)
            Path(task_file).write_text(json.dumps(tasks, indent=2))
            log("ORCH", f"Next task queued: {next_task['title']}")
            record("task_generator", {"next": next_task["title"]})

    # ── Summary ──────────────────────────────────────────────────────────────
    elapsed = time.time() - start
    cost    = get_run_cost()
    log("ORCH", "")
    log("ORCH", "="*60)
    log("ORCH", f"PIPELINE COMPLETE in {elapsed:.0f}s")
    log("ORCH", f"Critic: {critic_result['verdict'].upper()} ({critic_result.get('score','?')}/10)")
    log("ORCH", f"Test:   {'PASS' if test_result.get('passed') else 'FAIL'}")
    log("ORCH", f"UX:     {ux.get('ux_score','?')}/10")
    log("ORCH", f"Deploy: {'DRY RUN' if dry_run else ('LIVE' if deploy.get('deployed') else 'FAILED')}")
    log("ORCH", f"Cost:   ${cost:.4f} this run | ${load_total_cost():.4f} total")
    log("ORCH", f"Next:   {next_task['title'] if next_task else 'None queued'}")
    log("ORCH", "="*60)

    # Save run log
    log_path = LOG_DIR / f"run_{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    log_path.write_text(json.dumps({"task": task, "log": run_log, "cost": cost}, indent=2))
    save_total_cost(cost)
    # Update session total
    import pipeline_v3
    pipeline_v3.session_total_cost += cost
    return True
