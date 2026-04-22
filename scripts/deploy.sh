#!/usr/bin/env bash
# Deploy worms to mccarrison.me/worms via Cloudflare Workers + Durable Objects.
# Safety: only deploys from master, only with a clean tree.

set -euo pipefail

cd "$(dirname "$0")/.."

branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$branch" != "master" ]; then
  echo "ERROR: refusing to deploy from '$branch'. Switch to master."
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: uncommitted changes. Commit or stash first."
  exit 1
fi

echo "Building client..."
npm run build

echo "Deploying worker..."
cd worker
npx wrangler deploy

echo
echo "Live at https://mccarrison.me/worms/"
