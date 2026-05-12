#!/bin/bash
# Starts the Aisle infrastructure (Postgres, Redis, Qdrant, MinIO).
# Safe to call from any working directory — path is resolved from this file's location.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/../../docker/docker-compose.yml"

if ! command -v docker &>/dev/null; then
  echo "ERROR: Docker is not installed or not in PATH. Install Docker and try again."
  exit 1
fi

if ! docker info &>/dev/null; then
  echo "ERROR: Docker daemon is not running. Start Docker and try again."
  exit 1
fi

echo "Starting Aisle infrastructure..."
docker compose -f "$COMPOSE_FILE" up -d postgres redis qdrant minio --wait
echo "Infrastructure is ready."
