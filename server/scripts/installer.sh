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
if [ "$IS_DOCKER_HOST_PROXY" = "true" ]; then
  echo "Local install detected, skipping some setup steps"
  NEEDS_FULL_SETUP=false
  export ROUTER_BIND_ADDRESS=0.0.0.0
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
MIN_FREE_DISK_GB=10

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

read_router_syncstatus() {
    local path="$1"
    run_compose "sudo docker compose exec -T router curl -s http://127.0.0.1:8080${path}"
}

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
    run_command "sudo ufw allow 80/tcp"
    run_command "sudo ufw allow 443/tcp"

    run_command "sudo ufw --force enable"

    if [ "$NEEDS_FULL_SETUP" = true ]; then
        echo "-----------------------------------------------------------------"
        echo "CONFIGURING SWAP SPACE"

        command_output=$(run_command "sudo swapon --show=NAME --noheadings")
        if [ -n "$command_output" ]; then
            echo "Swap is already active:"
            echo "$command_output"
        else
            # Some 8GB Ubuntu hosts ship without swap, which can OOM Argon during the initial sync.
            swapfile_state=$(run_command "sudo bash -lc '[ -f /swapfile ] && echo present || echo absent'")
            if [ "$swapfile_state" = "present" ]; then
                swapfile_size=$(run_command "sudo stat -c %s /swapfile")
                if [ "$swapfile_size" -lt $((8 * 1024 * 1024 * 1024)) ]; then
                    echo "Existing /swapfile is smaller than 8G, recreating it"
                    run_command "sudo rm -f /swapfile"
                    swapfile_state="absent"
                fi
            fi

            if [ "$swapfile_state" = "absent" ]; then
                echo "Creating 8G /swapfile"
                allow_run_command_fail=1
                command_output=$(run_command "sudo fallocate -l 8G /swapfile")
                fallocate_status=${command_exit_status:-0}
                unset allow_run_command_fail

                if [ "$fallocate_status" -ne 0 ]; then
                    echo "fallocate failed, retrying with dd"
                    run_command "sudo dd if=/dev/zero of=/swapfile bs=1M count=8192 status=none"
                fi
            fi

            run_command "sudo chmod 600 /swapfile"
            run_command "sudo mkswap /swapfile"
            run_command "sudo swapon /swapfile"
            run_command "sudo grep -qE '^[[:space:]]*/swapfile[[:space:]]' /etc/fstab || sudo bash -c 'printf \"%s\\n\" \"/swapfile none swap sw 0 0\" >> /etc/fstab'"
        fi

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
      run_command "sudo apt install -y docker-ce-cli docker-buildx-plugin docker-compose-plugin"
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

    project_name="${COMPOSE_PROJECT_NAME:-argon}"
    network_name="${project_name}-net"
    status_container_ids=$(run_command "sudo docker ps -aq --filter \"label=com.docker.compose.project=${project_name}\" --filter \"label=com.docker.compose.service=status\"")
    if [ -n "$status_container_ids" ]; then
      echo "Found legacy status service containers, removing before starting router"
      run_command "sudo docker rm -f $status_container_ids"
    fi
    run_compose "sudo docker network inspect ${network_name} >/dev/null 2>&1 || sudo docker network create ${network_name}"
    run_compose "sudo docker compose up router -d --build"

    echo "-----------------------------------------------------------------"
    echo "PREPARING GATEWAY CERTIFICATES"

    if [ "${GATEWAY_CERTBOT_ENABLED:-false}" = "true" ]; then
      run_compose "sudo docker compose up gateway-certbot -d --build --wait"
    fi

    echo "-----------------------------------------------------------------"
    echo "VALIDATING GATEWAY CONFIG"

    run_compose "sudo docker compose build nginx"
    run_compose "sudo docker compose run --rm --no-deps nginx nginx -t"
    run_compose "sudo docker compose up nginx -d --build --wait"

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
    bitcoin_data_image="ghcr.io/argonprotocol/apps/${BITCOIN_DATA_SLUG}:latest"
    # if not regtest and data folder does not exist, run the bitcoin-data container to initialize it
    if [ ! -d "$BITCOIN_DATA_FOLDER" ] && [ "$BITCOIN_CHAIN" != "regtest" ]; then
      echo "Bootstrapping bitcoin-data (first run)"
      ensure_free_disk_space "$HOME_DIR"
      run_compose "sudo docker compose pull bitcoin-data"

      image_size_bytes=$(run_command "sudo docker image inspect --format '{{.Size}}' $bitcoin_data_image")
      if [[ ! "$image_size_bytes" =~ ^[0-9]+$ ]]; then
        failed "Could not determine bitcoin-data image size"
      fi
      bytes_per_gib=$((1024 * 1024 * 1024))
      snapshot_required_gb=$(((image_size_bytes + bytes_per_gib - 1) / bytes_per_gib + MIN_FREE_DISK_GB))
      ensure_free_disk_space "$HOME_DIR" "$snapshot_required_gb"

      run_compose "sudo docker compose run --rm --pull=never bitcoin-data"
    else
      echo "bitcoin-data already initialized, skipping bootstrap"
    fi

    if sudo docker image inspect "$bitcoin_data_image" >/dev/null 2>&1; then
      run_command "sudo docker image rm -f $bitcoin_data_image"
    fi
    ensure_free_disk_space "$HOME_DIR" "$MIN_FREE_DISK_GB" bitcoin-node

    if compose_service_hash_changed bitcoin-node; then
      echo "Bitcoin config changed → recreating container"
      run_compose "sudo docker compose build bitcoin-node"

      command_output=$(run_command "sudo docker images")
      if ! echo "$command_output" | grep -q "bitcoin-node"; then
          failed "bitcoin image was not found"
      fi
      run_compose "sudo docker compose up bitcoin-node -d --force-recreate --wait"
    else
      echo "Bitcoin config unchanged → reusing container"
      run_compose "sudo docker compose up bitcoin-node -d --no-recreate --wait"
    fi

    # Loop until syncstatus is >= 100%
    failures=0
    while true; do
        sleep 1
        ensure_free_disk_space "$HOME_DIR" "$MIN_FREE_DISK_GB" bitcoin-node
        allow_run_command_fail=1
        if ! command_output=$(read_router_syncstatus "/bitcoin/syncstatus"); then
          exit 1
        fi
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
         if [ "$failures" -ge 10 ]; then
           failed "Bitcoin syncstatus returned error JSON too many times"
         fi
         echo "Output: $command_output"
         echo "Bitcoin syncstatus returned error JSON ($failures / 10), retrying..."
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

    ensure_free_disk_space "$HOME_DIR" "$MIN_FREE_DISK_GB" argon-miner

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
        ensure_free_disk_space "$HOME_DIR" "$MIN_FREE_DISK_GB" argon-miner
        allow_run_command_fail=1
        if ! command_output=$(read_router_syncstatus "/argon/syncstatus"); then
          exit 1
        fi
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
    allow_run_command_fail=1
    if ! RESPONSE=$(run_compose "sudo docker compose exec -T bot curl -s -w \"\n%{http_code}\" http://127.0.0.1:8080/is-ready"); then
      exit 1
    fi
    unset allow_run_command_fail
    echo "$RESPONSE"
    status=${RESPONSE##*$'\n'}        # last line
    json=${RESPONSE%$'\n'*}           # all but last line
    if [[ "$status" == "200" && "$json" == "true" ]]; then
      echo "Bot is running"
      break;
    fi
    echo "Bot is not ready, waiting..."
done

gateway_deadline=$((SECONDS + 120))
while true; do
    sleep 1
    allow_run_command_fail=1
    if ! RESPONSE=$(run_compose "sudo docker compose exec -T nginx curl -kfsS --connect-timeout 2 --max-time 5 https://127.0.0.1/"); then
      exit 1
    fi
    unset allow_run_command_fail
    if jq -e '.status == "ok"' <<<"$RESPONSE" >/dev/null 2>&1; then
      echo "Server gateway is running"
      break
    fi

    if (( SECONDS >= gateway_deadline )); then
      failed "Server gateway did not become ready after 120 seconds"
    fi
    echo "Server gateway is not ready, waiting..."
done

echo "-----------------------------------------------------------------"
echo "REMOVING LEGACY PUBLIC ACCESS"

legacy_direct_ports=(3260 3261 9944 9945)
for legacy_port in "${legacy_direct_ports[@]}"; do
  if [ "$legacy_port" = "${BITCOIN_P2P_PORT:-}" ] || \
     [ "$legacy_port" = "${ARGON_P2P_PORT:-}" ] || \
     [ "$legacy_port" = "${GATEWAY_PORT:-443}" ]; then
    continue
  fi

  allow_run_command_fail=1
  run_command "yes | sudo ufw delete allow ${legacy_port}/tcp"
  run_command "yes | sudo ufw delete allow ${legacy_port}"
  unset allow_run_command_fail
done

allow_run_command_fail=1
broad_ufw_rule_numbers=$(run_command "sudo ufw status numbered | sed -nE 's/^\[[[:space:]]*([0-9]+)\][[:space:]]+Anywhere( \(v6\))?[[:space:]]+ALLOW IN[[:space:]]+([^[:space:]]+).*$/\1 \3/p' | awk '\$2 != \"Anywhere\" { print \$1 }' | sort -rn")
unset allow_run_command_fail
for broad_ufw_rule_number in $broad_ufw_rule_numbers; do
  run_command "yes | sudo ufw delete $broad_ufw_rule_number"
done

finish "MiningLaunch"

# Do NOT finish this step, it will be finished by the installer check
