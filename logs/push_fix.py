import json, base64, urllib.request

# Load credentials
env = json.load(open('../.env.json'))
token = env['GITHUB_TOKEN']
repo = 'davidmalky/renzo'

# Read the fixed file
print("Reading fixed index.html...")
content = open('index.html', 'rb').read()
encoded = base64.b64encode(content).decode()
print(f"File size: {len(content)} bytes")

# Get current SHA from GitHub
print("Getting current file SHA from GitHub...")
req = urllib.request.Request(
    f'https://api.github.com/repos/{repo}/contents/index.html',
    headers={
        'Authorization': f'token {token}',
        'Accept': 'application/vnd.github.v3+json'
    }
)
resp = json.loads(urllib.request.urlopen(req).read())
sha = resp['sha']
print(f"Current SHA: {sha}")

# Push the fixed file
print("Pushing fix to GitHub...")
data = json.dumps({
    'message': 'Fix broken doLogin function',
    'content': encoded,
    'sha': sha
}).encode()

req2 = urllib.request.Request(
    f'https://api.github.com/repos/{repo}/contents/index.html',
    data=data,
    method='PUT',
    headers={
        'Authorization': f'token {token}',
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.v3+json'
    }
)
result = json.loads(urllib.request.urlopen(req2).read())
print(f"SUCCESS! Commit: {result['commit']['sha']}")
print("Vercel will deploy in about 30 seconds.")
print("Login at: https://renzo-beige.vercel.app")
print("Username: admin  Password: renzo2024")
