#!/bin/bash

# Debug logging - use absolute path to ensure we catch all instances
DEBUG_LOG="/tmp/installer_debug.log"

SCRIPT_PATH="$(readlink -f "$0")"
SCRIPTS_DIR="$(dirname "$0")"
SERVER_DIR="$SCRIPTS_DIR/.."
HOME_DIR="$SERVER_DIR/.."
NEEDS_FULL_SETUP=true
logs_dir="$HOME_DIR/logs"
export DOCKER_BUILDKIT=1
LOCALHOST=127.0.0.1
if [ "$IS_DOCKER_HOST_PROXY" = "true" ]; then
  echo "Local install detected, skipping some setup steps"
  NEEDS_FULL_SETUP=false
  LOCALHOST=host.docker.internal
fi

# Prevent recursive execution
if [ "$PPID" != "1" ]; then
    echo "Error: This script should not be run as a child process. Please run it directly."
    exit 1
fi

# load the env file up one directory
if [ -f "$SERVER_DIR/.env" ]; then
  . "$SERVER_DIR/.env"
fi

# Debug logging
{
    echo "----------------------------------------"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Script started with PID $$"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Script path: $SCRIPT_PATH"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Command line: $0 $*"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Current directory: $(pwd)"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] User: $(whoami)"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Parent process: $(ps -o comm= -p $PPID)"
} >> "$DEBUG_LOG"

# Lock file path - use absolute path
LOCKFILE="/tmp/installer.lock"

# Function to clean up lock file on exit
cleanup() {
    local status=$?
    {
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] Cleaning up lock file for PID $$"
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] Script path: $SCRIPT_PATH"
    } >> "$DEBUG_LOG"
    rm -f "$LOCKFILE"
    exit $status
}

# Set up trap to clean up lock file on script exit
trap cleanup EXIT INT TERM

# Try to acquire lock
if ! (set -o noclobber; echo "$$" > "$LOCKFILE") 2>/dev/null; then
    # If we couldn't acquire the lock, check if the process is still running
    if [ -f "$LOCKFILE" ]; then
        pid=$(cat "$LOCKFILE")
        {
            echo "[$(date '+%Y-%m-%d %H:%M:%S')] Found existing lock file with PID $pid"
            echo "[$(date '+%Y-%m-%d %H:%M:%S')] Script path: $SCRIPT_PATH"
        } >> "$DEBUG_LOG"

        if ps -p "$pid" > /dev/null 2>&1; then
            {
                echo "[$(date '+%Y-%m-%d %H:%M:%S')] Process $pid is still running"
                echo "[$(date '+%Y-%m-%d %H:%M:%S')] Process command: $(ps -p $pid -o command=)"
            } >> "$DEBUG_LOG"
            echo "Error: Another instance of the script is already running (PID: $pid)"
            exit 1
        else
            # Process is not running, remove stale lock file
            {
                echo "[$(date '+%Y-%m-%d %H:%M:%S')] Process $pid is not running, removing stale lock"
                echo "[$(date '+%Y-%m-%d %H:%M:%S')] Script path: $SCRIPT_PATH"
            } >> "$DEBUG_LOG"
            rm -f "$LOCKFILE"
            # Try to acquire lock again
            if ! (set -o noclobber; echo "$$" > "$LOCKFILE") 2>/dev/null; then
                {
                    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Failed to acquire lock after removing stale lock"
                    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Script path: $SCRIPT_PATH"
                } >> "$DEBUG_LOG"
                echo "Error: Failed to acquire lock after removing stale lock file"
                exit 1
            fi
        fi
    else
        {
            echo "[$(date '+%Y-%m-%d %H:%M:%S')] Failed to acquire lock"
            echo "[$(date '+%Y-%m-%d %H:%M:%S')] Script path: $SCRIPT_PATH"
        } >> "$DEBUG_LOG"
        echo "Error: Failed to acquire lock"
        exit 1
    fi
fi

{
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Successfully acquired lock"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Script path: $SCRIPT_PATH"
} >> "$DEBUG_LOG"

# Source the helpers file
source "$SCRIPTS_DIR/helpers.sh"

########################################################################################
reset "FileUpload"
start "FileUpload"


finish "FileUpload"

########################################################################################
if ! (already_ran "UbuntuCheck"); then
    start "UbuntuCheck"

    echo "-----------------------------------------------------------------"
    echo "CHECKING UBUNTU VERSION"

    command_output=$(run_command "sudo cat /etc/os-release")
    # Extract VERSION_ID from the output
    version=$(echo "$command_output" | grep "^VERSION_ID=" | cut -d'"' -f2)
    if [ -z "$version" ]; then
        failed "Could not extract Ubuntu version from: $command_output"
    fi

    # Split version into major and minor
    major_version=$(echo "$version" | cut -d. -f1)
    minor_version=$(echo "$version" | cut -d. -f2)

    # Compare versions semantically
    if [ "$major_version" -lt 24 ] || ([ "$major_version" -eq 24 ] && [ "$minor_version" -lt 4 ]); then
        failed "Ubuntu version $version is less than required version 24.04"
    fi

    echo "-----------------------------------------------------------------"
    echo "SETTING UP UFW FIREWALL RULES"

    run_command "sudo apt update"

    run_command "sudo apt install -y ufw curl jq bc"

    command_output=$(run_command "sudo ufw app list | sudo grep -q '^OpenSSH$' && echo 'OpenSSH found' || echo 'OpenSSH not found'")
    if echo "$command_output" | grep -q 'OpenSSH found'; then
        echo "OpenSSH is already installed, allowing OpenSSH through UFW"
        run_command "sudo ufw allow OpenSSH"
    else
        run_command "sudo ufw allow 22/tcp"
    fi

    run_command "sudo ufw --force enable"

    if [ "$NEEDS_FULL_SETUP" = true ]; then
        echo "-----------------------------------------------------------------"
        echo "INSTALLING auditd and fail2ban"
        run_command "sudo apt install -y auditd fail2ban"

        run_command "sudo cp $SCRIPTS_DIR/conf/auditd_hardening.rules /etc/audit/rules.d/hardening.rules"
        run_command "sudo augenrules --load"

        run_command "sudo sed -i 's/^max_log_file *=.*/max_log_file = 200/' /etc/audit/auditd.conf"
        run_command "sudo sed -i 's/^max_log_file_action *=.*/max_log_file_action = rotate/' /etc/audit/auditd.conf"
        run_command "sudo sed -i 's/^space_left_action *=.*/space_left_action = email/' /etc/audit/auditd.conf"
        run_command "sudo sed -i 's/^admin_space_left_action *=.*/admin_space_left_action = single/' /etc/audit/auditd.conf"
        run_command "sudo sed -i 's/^disk_full_action *=.*/disk_full_action = ignore/' /etc/audit/auditd.conf"
        run_command "sudo sed -i 's/^disk_error_action *=.*/disk_error_action = ignore/' /etc/audit/auditd.conf"
        run_command "sudo sed -i 's/^num_logs *=.*/num_logs = 10/' /etc/audit/auditd.conf"

        run_command "sudo systemctl restart auditd"

        run_command "sudo mkdir -p /etc/fail2ban/jail.d || true"
        run_command "sudo cp $SCRIPTS_DIR/conf/fail2ban_sshd.local /etc/fail2ban/jail.d/sshd.local"
        run_command "sudo cp $SCRIPTS_DIR/conf/fail2ban_recidive.local /etc/fail2ban/jail.d/recidive.local"
        run_command "sudo systemctl enable fail2ban --now"
        run_command "sudo systemctl restart fail2ban"
    fi

    finish "UbuntuCheck"
fi

########################################################################################

cd "$SERVER_DIR" || exit 1

########################################################################################
if ! (already_ran "DockerInstall"); then
    start "DockerInstall"

    echo "-----------------------------------------------------------------"
    echo "INSTALLING DOCKER"

    sleep 2
    run_command "sudo apt update"

    run_command "sudo apt install -y \
        ca-certificates \
        curl \
        gnupg \
        lsb-release"

    run_command "sudo mkdir -p /etc/apt/keyrings"
    run_command "sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
        sudo gpg --yes --dearmor -o /etc/apt/keyrings/docker.gpg"

    echo \
        "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
        https://download.docker.com/linux/ubuntu \
        $(lsb_release -cs) stable" | \
        sudo tee /etc/apt/sources.list.d/docker.list > /dev/null


    run_command "sudo apt update"

    if [ "$NEEDS_FULL_SETUP" = false ]; then
      echo "Local install detected, installing only docker CLI and compose plugin"
      run_command "sudo apt install -y docker-cli docker-buildx-plugin docker-compose-plugin"
    else
      echo "Remote install detected, installing full Docker engine"
      run_command "sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin"
      run_command "sudo systemctl enable docker --now"
      run_command "sudo systemctl status docker"
    fi

    run_command "sudo docker image prune -af \
      --filter \"label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}\" \
      >/dev/null 2>&1 || true"

    command_output=$(run_command "sudo docker --version")

    # Extract version numbers from the output - handle both 2 and 3 number versions
    version=$(echo "$command_output" | grep -oE '[0-9]+(\.[0-9]+){1,2}' | head -1)
    if [ -z "$version" ]; then
        failed "Could not extract Docker version from: $command_output"
    fi

    # Get major version
    major_version=$(echo "$version" | cut -d. -f1)

    # Compare major version
    if [ "$major_version" -lt 27 ]; then
        failed "Docker version $version is less than required major version 27"
    fi

    network_name="${COMPOSE_PROJECT_NAME:-argon}-net"
    run_compose "sudo docker network inspect ${network_name} >/dev/null 2>&1 || sudo docker network create ${network_name}"
    run_compose "sudo docker compose up status -d --build"

    finish "DockerInstall" "$command_output"
fi

########################################################################################
if ! (already_ran "BitcoinInstall"); then
    start "BitcoinInstall"

    echo "-----------------------------------------------------------------"
    echo "BUILDING BITCOIN FOR $ARGON_CHAIN"

    run_command "sudo ufw allow $BITCOIN_P2P_PORT/tcp"

    echo "-----------------------------------------------------------------"
    echo "RUNNING BITCOIN-DATA CONTAINER"
    echo "- Checking ${BITCOIN_DATA_FOLDER} for existing data"
    # if not regtest and data folder does not exist, run the bitcoin-data container to initialize it
    if [ ! -d "$BITCOIN_DATA_FOLDER" ] && [ "$BITCOIN_CHAIN" != "regtest" ]; then
      echo "Bootstrapping bitcoin-data (first run)"
      run_compose "sudo docker compose pull bitcoin-data"
      run_compose "sudo docker compose run --rm --pull=never bitcoin-data"
      run_compose "sudo docker rmi -f bitcoin-data:latest || true"
    else
      echo "bitcoin-data already initialized, skipping bootstrap"
    fi

    if compose_service_hash_changed bitcoin-node; then
      echo "Bitcoin config changed → recreating container"
      run_compose "sudo docker compose build bitcoin-node"

      command_output=$(run_command "sudo docker images")
      if ! echo "$command_output" | grep -q "bitcoin-node"; then
          failed "bitcoin image was not found"
      fi
      run_compose "sudo docker compose up bitcoin-node -d --force-recreate"
    else
      echo "Bitcoin config unchanged → reusing container"
      run_compose "sudo docker compose up bitcoin-node -d --no-recreate"
    fi

    # Loop until syncstatus is >= 100%
    failures=0
    while true; do
        sleep 1
        allow_run_command_fail=1
        command_output=$(run_command "sudo curl -s http://${LOCALHOST}:${STATUS_PORT}/bitcoin/syncstatus" )
        unset allow_run_command_fail

        if [[ "${command_exit_status:-0}" -eq 52 ]]; then
          echo "Bitcoin syncstatus transient empty reply (curl exit 52), retrying..."
          continue
        fi

        # Check if command failed
        if [[ -z "$command_output" ]] || \
           ! jq empty <<<"$command_output" >/dev/null 2>&1 || \
           jq -e '.error? // empty' <<<"$command_output" >/dev/null 2>&1; then
         failures=$((failures + 1))
         if [ "$failures" -ge 5 ]; then
           failed "Bitcoin syncstatus returned error JSON too many times"
         fi
         echo "Bitcoin syncstatus returned error JSON ($failures / 5), retrying..."
         continue
        fi

        failures=0
        percent_value=$(echo "$command_output" | jq -r '.syncPercent // 0 | floor')
        if (( percent_value >= 100 )); then
            echo "Bitcoin Sync is complete (>= 100%)"
            break
        else
            echo "Bitcoin Sync is not complete (< 100%), waiting... ($percent_value%)"
        fi
    done

    finish "BitcoinInstall"
fi

########################################################################################
if ! (already_ran "ArgonInstall"); then
    start "ArgonInstall"

    echo "-----------------------------------------------------------------"
    echo "BUILDING ARGON-MINER FOR $ARGON_CHAIN"

    run_command "sudo ufw allow ${ARGON_P2P_PORT}/tcp"

    if [[ "$ARGON_VERSION" != "dev" ]]; then
      echo "Ensuring Argon Miner image ($ARGON_VERSION) is present"
      run_compose "sudo docker compose pull argon-miner"
    else
      echo "Using local Argon Miner (dev)"
    fi

    command_output=$(run_command "sudo docker images")
    if ! echo "$command_output" | grep -q "argon-miner"; then
        failed "argon-miner image was not found"
    fi

    if compose_service_hash_changed argon-miner; then
      echo "Argon config changed → recreating container"
      run_compose "sudo docker compose up argon-miner -d --force-recreate"
    else
      echo "Argon config unchanged → reusing container"
      run_compose "sudo docker compose up argon-miner -d --no-recreate"
    fi

    # Loop until syncstatus is >= 100%
    failures=0
    while true; do
        sleep 1
        allow_run_command_fail=1
        command_output=$(run_command "sudo curl -s http://${LOCALHOST}:${STATUS_PORT}/argon/syncstatus")
        unset allow_run_command_fail

        if [[ "${command_exit_status:-0}" -eq 52 ]]; then
          echo "Argon syncstatus transient empty reply (curl exit 52), retrying..."
          continue
        fi
        # Check if the response failed
        if [[ -z "$command_output" ]] || \
           ! jq empty <<<"$command_output" >/dev/null 2>&1 || \
           jq -e '.error? // empty' <<<"$command_output" >/dev/null 2>&1; then
         failures=$((failures + 1))
         if [ "$failures" -ge 5 ]; then
           failed "Argon syncstatus returned error JSON too many times"
         fi
         echo "Argon syncstatus returned error JSON ($failures / 5), retrying..."
         continue
        fi

        failures=0
        percent_value=$(echo "$command_output" | jq -r '.syncPercent // 0 | floor')
        echo "Argon Sync... ($percent_value%)"
        if (( percent_value >= 100 )); then
            echo "Argon Sync is complete (>= 100%)"
            break
        fi
    done

    finish "ArgonInstall"
fi

########################################################################################
reset "MiningLaunch"
start "MiningLaunch"

echo "-----------------------------------------------------------------"
echo "STARTING BOT ON $ARGON_CHAIN"

run_compose "sudo docker compose build bot"
if compose_service_hash_changed bot; then
  echo "Bot config changed → recreating container"
  run_compose "sudo docker compose up bot -d --force-recreate"
else
  echo "Bot config unchanged → reusing container"
  run_compose "sudo docker compose up bot -d"
fi

while true; do
    sleep 1
    RESPONSE=$(curl -s -w "\n%{http_code}" "http://${LOCALHOST}:${BOT_PORT}/is-ready" || echo -e "\n000")
    echo "$RESPONSE"
    status=${RESPONSE##*$'\n'}        # last line
    json=${RESPONSE%$'\n'*}           # all but last line
    if [[ "$status" == "200" && "$json" == "true" ]]; then
      echo "Bot is running"
      break;
    fi
    echo "Bot is not ready, waiting..."
done

finish "MiningLaunch"

# Do NOT finish this step, it will be finished by the installer check
