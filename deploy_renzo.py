"""
deploy_renzo.py — Deploy the complete working Renzo to GitHub
Run this from ANYWHERE — it always uses renzo_complete.html in the same folder
"""
import os, sys, json, requests, base64
from pathlib import Path

# ── Config ──────────────────────────────────────────────────────────────────
GITHUB_TOKEN = ""   # ← paste your GitHub token here
GITHUB_REPO  = "davidmalky/renzo"
SOURCE_FILE  = Path(__file__).parent / "renzo_complete.html"

# ── Load token from env.json if not set above ────────────────────────────────
if not GITHUB_TOKEN:
    env_path = Path(r"F:\davidmalky\Files\Ai\Claude\agent_pipeline\.env.json")
    if env_path.exists():
        GITHUB_TOKEN = json.loads(env_path.read_text()).get("GITHUB_TOKEN","")

if not GITHUB_TOKEN:
    print("ERROR: No GitHub token found. Paste it into this file.")
    input("Press Enter to exit...")
    sys.exit(1)

if not SOURCE_FILE.exists():
    print(f"ERROR: Source file not found: {SOURCE_FILE}")
    print("Make sure renzo_complete.html is in the same folder as this script.")
    input("Press Enter to exit...")
    sys.exit(1)

# ── Deploy ───────────────────────────────────────────────────────────────────
print(f"Reading {SOURCE_FILE.name} ({SOURCE_FILE.stat().st_size:,} bytes)...")
html    = SOURCE_FILE.read_text(encoding="utf-8")
url     = f"https://api.github.com/repos/{GITHUB_REPO}/contents/index.html"
headers = {"Authorization": f"token {GITHUB_TOKEN}", "Accept": "application/vnd.github.v3+json"}

r   = requests.get(url, headers=headers)
sha = r.json().get("sha","") if r.status_code == 200 else ""

payload = {
    "message": "deploy: complete Renzo with all features",
    "content": base64.b64encode(html.encode("utf-8")).decode("utf-8")
}
if sha: payload["sha"] = sha

print(f"Pushing to {GITHUB_REPO}...")
r = requests.put(url, headers=headers, json=payload)

if r.status_code in (200, 201):
    print(f"\n✓ SUCCESS — deployed {len(html):,} chars")
    print(f"  Vercel will update in ~30 seconds")
    print(f"  Visit: https://renzo-beige.vercel.app")
else:
    print(f"\n✗ FAILED: {r.status_code}")
    print(r.text[:300])

input("\nPress Enter to close...")
