"""
Reset all tasks in a task file back to 'pending' status.
Usage: python reset_tasks.py tasks_renzo_v2.json
"""
import sys, json
from pathlib import Path

task_file = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / "tasks_renzo_v2.json"

if not task_file.exists():
    print(f"File not found: {task_file}")
    sys.exit(1)

tasks = json.loads(task_file.read_text())
for t in tasks:
    old = t.get("status", "pending")
    t["status"] = "pending"
    t.pop("completed_at", None)
    t.pop("retry_count", None)
    t.pop("last_attempted", None)
    print(f"  Reset: {t['title'][:60]} ({old} → pending)")

task_file.write_text(json.dumps(tasks, indent=2))
print(f"\nDone — {len(tasks)} task(s) reset to pending in {task_file.name}")
