#!/usr/bin/env bash
# Checks that the Electron runtime libs and xvfb are installed, and only falls
# back to apt when one is missing (#591). The runner image already ships all
# nine (its Chrome .deb pulls them in), so the normal path makes no apt call.
#
# The t64 names are the installed package names on noble: a check written with
# `libatk-bridge2.0-0` and the like never matches and always falls through.
set -euo pipefail

pkgs=(xvfb libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 libgtk-3-0t64 libgbm1 libasound2t64 libxshmfence1 libdrm2)
arch=$(dpkg --print-architecture)

# The status, not `dpkg -s`'s exit code, which is 0 for a package left in
# `config-files` state too. Arch-qualified, because a package installed for
# both amd64 and i386 prints `ii ii ` otherwise.
missing() {
  local p
  for p in "${pkgs[@]}"; do
    if [ "$(dpkg-query -W -f='${db:Status-Abbrev}' "$p:$arch" 2>/dev/null)" != 'ii ' ]; then
      echo "$p"
    fi
  done
}

absent=$(missing)
if [ -z "$absent" ]; then
  echo "All ${#pkgs[@]} Electron runtime packages are installed: ${pkgs[*]}"
  exit 0
fi
echo "::warning::Not installed: $(echo $absent); falling back to apt"

# apt moves to the next mirror in /etc/apt/apt-mirrors.txt (`URL<TAB>priority:N`,
# read through `mirror+file:`) only when a request fails, and a crawl never
# trips its idle timeout. So each attempt rewrites the list and runs under
# `timeout`: `update`, then a download-only install, which a kill can never
# catch inside dpkg. Completed .debs stay in /var/cache/apt/archives for the
# final install. No `-o Acquire::…` overrides: the image's `zz-retries`
# (Retries 1, Timeout 15) fails over faster than any higher retry count.
A=https://archive.ubuntu.com/ubuntu/
Z=http://azure.archive.ubuntu.com/ubuntu/
K=http://mirrors.edge.kernel.org/ubuntu/
S=https://security.ubuntu.com/ubuntu/
use() {
  printf '%s\tpriority:1\n%s\tpriority:2\n%s\tpriority:3\n' "$1" "$2" "$S" |
    sudo tee /etc/apt/apt-mirrors.txt >/dev/null
}

ok=
for pair in "$A $Z" "$Z $A" "$K $A"; do
  # shellcheck disable=SC2086 # unquoted on purpose: splits into the two URLs
  use $pair
  if sudo timeout -k 10 60 apt-get update -q &&
    sudo timeout -k 10 150 apt-get install -yq --no-install-recommends --download-only "${pkgs[@]}"; then
    ok=1
    break
  fi
  echo "::warning::apt stalled or failed on ${pair%% *}; rotating mirror"
done
if [ -z "$ok" ]; then
  echo '::error::apt failed on every mirror; giving up'
  exit 1
fi
sudo apt-get install -yq --no-install-recommends "${pkgs[@]}"

absent=$(missing)
if [ -n "$absent" ]; then
  echo "::error::Still not installed after apt: $(echo $absent)"
  exit 1
fi
