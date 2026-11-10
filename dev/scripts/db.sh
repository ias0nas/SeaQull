#!/usr/bin/env bash
# Local SQL Server helper. Commands: up | seed [db...] | sql [query] | logs | down | nuke
# Written for macOS's bash 3.2: no associative arrays, and no unicode right after "$var".
set -euo pipefail
DEV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$DEV_DIR/.env"
BACKUP_DIR="$DEV_DIR/backups"
# sqlcmd takes the password from SQLCMDPASSWORD, set on the container in compose.yml.
SQLCMD=(/opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa)

compose() {
  if [[ -f "$ENV_FILE" ]]; then
    docker compose --project-directory "$DEV_DIR" -f "$DEV_DIR/compose.yml" --env-file "$ENV_FILE" "$@"
  else
    # Lets down/nuke work even after dev/.env was deleted; compose.yml requires the variable.
    MSSQL_SA_PASSWORD="${MSSQL_SA_PASSWORD:-unset}" docker compose --project-directory "$DEV_DIR" -f "$DEV_DIR/compose.yml" "$@"
  fi
}

ensure_env() {
  if [[ ! -f "$ENV_FILE" ]]; then
    # Local dev only; never reuse this password anywhere else.
    printf 'MSSQL_SA_PASSWORD=Sq1-%s\n' "$(openssl rand -hex 12)" > "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    echo "Generated $ENV_FILE"
  fi
}

require_running() {
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "No $ENV_FILE yet: run '$0 up' first." >&2; exit 1
  fi
  if [[ -z "$(compose ps --status running -q mssql 2>/dev/null)" ]]; then
    echo "SQL Server container is not running: run '$0 up' first." >&2; exit 1
  fi
}

run_sql() { compose exec -T mssql "${SQLCMD[@]}" "$@"; }

# Sample databases from github.com/microsoft/sql-server-samples releases.
DEFAULT_SAMPLES="AdventureWorks2022 AdventureWorksLT2022 WideWorldImporters"
sample_url() {
  local base="https://github.com/Microsoft/sql-server-samples/releases/download"
  case "$1" in
    AdventureWorks2022)   echo "$base/adventureworks/AdventureWorks2022.bak" ;;
    AdventureWorksLT2022) echo "$base/adventureworks/AdventureWorksLT2022.bak" ;;
    WideWorldImporters)   echo "$base/wide-world-importers-v1.0/WideWorldImporters-Full.bak" ;;
    *) echo "unknown sample database: $1 (known: $DEFAULT_SAMPLES)" >&2; return 1 ;;
  esac
}

download() {
  local url="$1" dest="$2"
  [[ -f "$dest" ]] && return
  echo "Downloading $(basename "$dest")..."
  # Download beside the target and rename when complete, so an interrupted
  # download never leaves a truncated .bak that later runs would reuse.
  curl -fsSL -o "$dest.part" "$url"
  mv "$dest.part" "$dest"
}

seed_one() {
  local db="$1" url file online moves
  url="$(sample_url "$db")"
  file="$(basename "$url")"
  mkdir -p "$BACKUP_DIR"
  download "$url" "$BACKUP_DIR/$file"
  # Only an ONLINE database counts; one left RESTORING/RECOVERING by a failed run is restored over.
  online="$(run_sql -h -1 -W -Q "SET NOCOUNT ON; SELECT CASE WHEN DATABASEPROPERTYEX(N'$db', 'Status') = 'ONLINE' THEN 1 ELSE 0 END")"
  if [[ "$(echo "$online" | tr -d '[:space:]')" == "1" ]]; then
    echo "$db already restored"; return
  fi
  echo "Restoring ${db}..."
  # Relocate every logical file into the container's data dir. FILELISTONLY columns:
  # LogicalName|PhysicalName|Type|... with Type D (data), L (log), S (FILESTREAM /
  # memory-optimized container, a directory) or F (full-text catalog).
  moves="$(run_sql -h -1 -W -s '|' -Q "SET NOCOUNT ON; RESTORE FILELISTONLY FROM DISK='/backups/$file'" \
    | awk -F'|' -v db="$db" 'NF > 2 {
        if ($3 == "D") { name = (seen_data++ ? db "_" $1 ".ndf" : db ".mdf") }
        else if ($3 == "L") { name = db "_" $1 ".ldf" }
        else { name = db "_" $1 }
        printf ", MOVE N'\''%s'\'' TO N'\''/var/opt/mssql/data/%s'\''", $1, name
      }')"
  run_sql -b -Q "RESTORE DATABASE [$db] FROM DISK='/backups/$file' WITH REPLACE, STATS=25$moves"
}

case "${1:-}" in
  up)
    ensure_env
    compose up -d --wait
    run_sql -h -1 -W -Q "SET NOCOUNT ON; SELECT @@VERSION"
    ;;
  seed)
    shift
    require_running
    # shellcheck disable=SC2086 # word-split the default list on purpose
    [[ $# -gt 0 ]] || set -- $DEFAULT_SAMPLES
    for db in "$@"; do seed_one "$db"; done
    ;;
  sql)
    shift
    require_running
    if [[ $# -gt 0 ]]; then run_sql -Q "$*"; else compose exec mssql "${SQLCMD[@]}"; fi
    ;;
  logs) compose logs -f mssql ;;
  down) compose down ;;
  nuke) compose down -v ;;
  *) echo "usage: $0 up | seed [db...] | sql [query] | logs | down | nuke" >&2; exit 2 ;;
esac
