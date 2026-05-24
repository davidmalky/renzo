"""
Pipeline v3 Runner - Self-propelling overnight agent system
Usage:
  python run_v3.py tasks_renzo.json          # dry run
  LIVE_DEPLOY=1 python run_v3.py tasks_renzo.json   # live deploy + auto-propel
"""

import os, sys, json, time, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from pipeline_v3 import orchestrator, log, load_total_cost, LOG_DIR

def main():
    task_file = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / "tasks.json"
    dry_run    = os.environ.get("LIVE_DEPLOY","0") != "1"
    auto_propel = os.environ.get("AUTO_PROPEL","1") == "1"

    print(f"\n{'='*70}")
    print(f"  AGENT PIPELINE v3 — {datetime.datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print(f"  Mode: {'DRY RUN' if dry_run else 'LIVE DEPLOY'}")
    print(f"  Auto-propel: {'ON' if auto_propel else 'OFF'}")
    print(f"  Total spent to date: ${load_total_cost():.4f}")
    print(f"{'='*70}\n")

    if not task_file.exists():
        print(f"Task file not found: {task_file}")
        sys.exit(1)

    loops = 0
    max_loops = 50  # safety ceiling — won't run more than 50 tasks in one session

    while loops < max_loops:
        tasks   = json.loads(task_file.read_text(encoding='utf-8'))
        pending = [t for t in tasks if t.get("status") == "pending"]

        if not pending:
            print(f"\n{'='*70}")
            print(f"  No pending tasks — pipeline complete")
            print(f"  Total tasks run this session: {loops}")
            print(f"{'='*70}\n")
            break

        task = pending[0]
        loops += 1

        print(f"\n{'─'*70}")
        print(f"  Task {loops}: {task['title']}")
        print(f"  {'Auto-generated' if task.get('auto_generated') else 'Manual'}")
        if task.get('rationale'):
            print(f"  Why: {task['rationale'][:80]}")
        print(f"{'─'*70}\n")

        # Mark running
        tasks = json.loads(task_file.read_text(encoding='utf-8'))
        for t in tasks:
            if t.get("id") == task.get("id"):
                t["status"] = "running"
        task_file.write_text(json.dumps(tasks, indent=2))

        try:
            success = orchestrator(task, dry_run=dry_run, task_file=str(task_file), auto_propel=auto_propel and not dry_run)
            status  = "done" if success else "pending"
        except Exception as e:
            log("RUNNER", f"Exception: {e}")
            success = False
            status  = "pending"

        # Update status
        tasks = json.loads(task_file.read_text(encoding='utf-8'))
        for t in tasks:
            if t.get("id") == task.get("id"):
                t["status"] = status
                if status == "done":
                    t["completed_at"] = datetime.datetime.now().isoformat()
                else:
                    t["retry_count"]    = t.get("retry_count",0) + 1
                    t["last_attempted"] = datetime.datetime.now().isoformat()
        task_file.write_text(json.dumps(tasks, indent=2))

        if not auto_propel or dry_run:
            print(f"\nAuto-propel {'disabled' if not auto_propel else 'off in dry-run mode'} — stopping after one task")
            break

        if not success:
            print(f"\nTask failed — will retry on next run. Stopping session.")
            break

        time.sleep(5)  # brief pause between tasks

    print(f"\n{'='*70}")
    print(f"  SESSION COMPLETE")
    print(f"  Tasks run: {loops}")
    print(f"  Logs: {LOG_DIR}")
    print(f"{'='*70}\n")

if __name__ == "__main__":
    main()
