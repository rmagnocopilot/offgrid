#!/usr/bin/env python3
"""
Atualiza os SHA-256 dos binários no manifest.json.
Uso: python3 scripts/update-binary-sha.py WIN_SHA LINUX_SHA MACOS_ARM_SHA MACOS_X64_SHA
"""
import json
import sys

if len(sys.argv) != 5:
    print("Uso: update-binary-sha.py WIN_SHA LINUX_SHA MACOS_ARM_SHA MACOS_X64_SHA")
    sys.exit(1)

win_sha, linux_sha, macos_arm_sha, macos_x64_sha = sys.argv[1:5]

sha_map = {
    "llama-server-win-x64.exe": win_sha,
    "llama-server-linux-x64": linux_sha,
    "llama-server-darwin-arm64": macos_arm_sha,
    "llama-server-darwin-x64": macos_x64_sha
}

with open("models/manifest.json", "r", encoding="utf-8") as f:
    manifest = json.load(f)

for binary in manifest.get("binaries", []):
    if binary["fileName"] in sha_map:
        binary["sha256"] = sha_map[binary["fileName"]]
        print(f"Atualizado: {binary['fileName']} -> {binary['sha256'][:16]}...")

with open("models/manifest.json", "w", encoding="utf-8") as f:
    json.dump(manifest, f, ensure_ascii=False, indent=2)
    f.write("\n")

print("manifest.json atualizado com sucesso.")