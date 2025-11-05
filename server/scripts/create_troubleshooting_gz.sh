#!/usr/bin/env bash
set -euo pipefail
# set -x
# Point this to your install logs directory (override with env if needed)
DIRNAME="$(dirname "$0")"
ROOT_DIR="$(realpath "$DIRNAME/../..")"
INSTALL_LOG_DIR="$ROOT_DIR/logs"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
HOST="$(hostname -s || echo host)"
OUTROOT="/tmp/troubleshooting-${HOST}-${STAMP}"
OUT="${OUTROOT}"
mkdir -p "${OUT}"/{docker,install,logs}

# --- System snapshots ---
{
  echo "---- /etc/os-release ----"; (cat /etc/os-release 2>/dev/null || true)
  echo "---- uname -a ----"; uname -a
  echo "---- timedatectl ----"; (timedatectl 2>/dev/null || true)
  echo "---- date -u ----"; date -u
  echo "---- df -h ----"; df -h
  echo "---- free/vm_stat ----"; (free -m 2>/dev/null || vm_stat 2>/dev/null || true)
  echo "---- uptime ----"; uptime
} > "${OUT}/sysinfo.txt" 2>&1 || true

# --- Docker env snapshots ---
docker system df > "${OUT}/docker/system-df.txt" 2>&1 || true

echo "[*] Container restart summary"
docker ps -a \
  --format 'table {{.Names}}\t{{.ID}}\t{{.Status}}\t{{.RunningFor}}\t{{.Image}}' \
  > "${OUT}/docker/restart-summary.txt"

# Add explicit restart counts, exit codes, health (using inspect template)
docker ps -a -q | while read -r id; do
  docker inspect -f \
'{{.Name}} RestartCount={{.RestartCount}} ExitCode={{.State.ExitCode}} Status={{.State.Status}} StartedAt={{.State.StartedAt}} FinishedAt={{.State.FinishedAt}} Health={{if .State.Health}}{{.State.Health.Status}}{{end}}' \
  "$id"
done >> "${OUT}/docker/restart-summary.txt" 2>/dev/null || true

# --- Network snapshot ---
# --- Network (merged, low-noise) ---
NET_OUT="${OUT}/net-summary.txt"
{
  echo "==== BASIC ===="
  echo "Host: $(hostname -f 2>/dev/null || hostname)"
  echo "Default route:"
  (ip route show default 2>/dev/null || true)
  echo
  echo "Addresses (brief):"
  (ip -brief addr 2>/dev/null || true)
  echo
  echo "DNS (from resolv.conf):"
  (grep -E '^(nameserver|search|options)' /etc/resolv.conf 2>/dev/null || true)

  echo
  echo "==== DOCKER NETWORKS ===="
  docker network ls --format 'NAME={{.Name}} DRIVER={{.Driver}} ID={{.ID}}' 2>/dev/null || true

  # Per-network minimal inspect: name, driver, subnets, container count
  while read -r nid; do
    docker network inspect "$nid" \
      --format '{{.Name}} driver={{.Driver}} subnets={{range .IPAM.Config}}{{.Subnet}} {{end}} containers={{len .Containers}}' \
      2>/dev/null || true
  done < <(docker network ls -q)

} > "$NET_OUT"

# Listening ports (host) and container port mappings, side-by-side
PORTS_OUT="${OUT}/ports-summary.txt"
{
  echo "==== HOST LISTENING TCP PORTS ===="
  if command -v ss >/dev/null 2>&1; then
    ss -lntp 2>/dev/null | awk 'NR==1||/LISTEN/{print}'
  elif command -v netstat >/dev/null 2>&1; then
    netstat -plant 2>/dev/null | awk 'NR==2||/LISTEN/{print}'
  fi

  echo
  echo "==== CONTAINER PORT MAPPINGS ===="
  docker ps --format 'NAME={{.Names}}  PORTS={{.Ports}}  ID={{.ID}}' 2>/dev/null || true
} > "$PORTS_OUT"


echo "[*] Host & Docker summaries"
docker info > "${OUT}/docker/info.txt" 2>&1 || true
docker version > "${OUT}/docker/version.txt" 2>&1 || true
docker ps -a > "${OUT}/docker/ps-a.txt" 2>&1 || true
docker compose ls > "${OUT}/docker/compose-ls.txt" 2>&1 || true

echo "[*] Capturing logs for all containers"
# Dump stdout/stderr (human-readable) + metadata for every container
docker ps -a --format '{{.ID}} {{.Names}}' | while read -r id name; do
  safe="${name//\//_}"
  docker logs --timestamps --details "$id" > "${OUT}/logs/${safe}.log" 2>&1 || true
  docker inspect "$id" > "${OUT}/docker/${safe}.inspect.json" 2>&1 || true
done

echo "[*] Copying install logs"
if [[ -d "$INSTALL_LOG_DIR" ]]; then
  rsync -a --delete "$INSTALL_LOG_DIR"/ "${OUT}/install/" || true
else
  echo "INSTALL_LOG_DIR '$INSTALL_LOG_DIR' not found" > "${OUT}/install/README.txt"
fi

# --- Security snapshot (low-noise) ---
mkdir -p "${OUT}/security"
SEC="${OUT}/security"
SINCE="$(date -u -d '48 hours ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -v -48H -u +%Y-%m-%dT%H:%M:%SZ)"

# 1) Auth & sudo
{
  echo "==== AUTH/SUDO (last 48h) ===="
  if command -v journalctl >/dev/null 2>&1; then
    echo "-- sshd --"; journalctl -u ssh -u sshd --since="$SINCE" --no-pager || true
    echo "-- sudo --"; journalctl _COMM=sudo --since="$SINCE" --no-pager || true
  else
    # Non-systemd fallback (Debian/Ubuntu): /var/log/auth.log; (RHEL): /var/log/secure
    for f in /var/log/auth.log /var/log/secure; do [[ -f $f ]] && echo "-- $f --" && tail -n 500 "$f"; done
    [[ -f /var/log/sudo.log ]] && echo "-- /var/log/sudo.log --" && tail -n 500 /var/log/sudo.log
  fi
} > "${SEC}/auth-sudo-48h.txt" 2>&1 || true

# 2) SSH config (sanitized, effective)
{
  echo "==== sshd -T (effective) ===="; (sshd -T 2>/dev/null || true)
  echo; echo "==== /etc/ssh/sshd_config ===="; (sed 's/^\(.*PasswordAuthentication.*\)/\1/g' /etc/ssh/sshd_config 2>/dev/null || true)
} > "${SEC}/ssh-config.txt" 2>&1 || true

# 3) Accounts & access
{
  echo "==== SUDOERS MEMBERS ===="; (getent group sudo 2>/dev/null || getent group wheel 2>/dev/null || true)
  echo; echo "==== LAST LOGINS (recent) ===="; (last -n 50 2>/dev/null || true)
  echo; echo "==== FAILED LOGINS (recent) ===="; (lastb -n 50 2>/dev/null || true)
} > "${SEC}/accounts.txt" 2>&1 || true

# 4) Firewall & listening services
{
  echo "==== UFW ===="; (ufw status verbose 2>/dev/null || true)
  echo; echo "==== iptables-save ===="; (iptables-save 2>/dev/null || true)
  echo; echo "==== nft list ruleset (if nftables) ===="; (nft list ruleset 2>/dev/null || true)
  echo; echo "==== LISTENING TCP (host) ====";
  if command -v ss >/dev/null 2>&1; then ss -lntp 2>/dev/null | awk 'NR==1||/LISTEN/'; else netstat -plant 2>/dev/null | awk 'NR==2||/LISTEN/'; fi
} > "${SEC}/firewall-ports.txt" 2>&1 || true

# 5) Auditd / Fail2ban (if present)
{
  echo "==== auditd status ===="; (auditctl -s 2>/dev/null || true)
  echo; echo "==== aureport --summary (48h) ===="; (aureport --summary --start "$SINCE" 2>/dev/null || true)
} > "${SEC}/auditd.txt" 2>&1 || true

{
  echo "==== fail2ban (status & last 200 log lines) ===="
  (fail2ban-client status 2>/dev/null || true)
  for f in /var/log/fail2ban.log /var/log/fail2ban/fail2ban.log; do
    [[ -f $f ]] && echo "-- $f --" && tail -n 200 "$f"
  done
} > "${SEC}/fail2ban.txt" 2>&1 || true

# 6) Scheduled tasks (quick visibility)
{
  echo "==== systemd timers ===="; (systemctl list-timers --all 2>/dev/null || true)
  echo; echo "==== crontab (root) ===="; (crontab -l 2>/dev/null || true)
  echo; echo "==== /etc/cron.* ===="; for d in /etc/cron.hourly /etc/cron.daily /etc/cron.weekly /etc/cron.d; do [[ -d $d ]] && echo "-- $d --" && ls -l "$d"; done
} > "${SEC}/schedules.txt" 2>&1 || true

# 7) Privileged binaries snapshot (bounded)
{
  echo "==== setuid/setgid binaries (top 200) ====";
  find / -xdev \( -perm -4000 -o -perm -2000 \) -type f 2>/dev/null | head -n 200 | sort
  echo; echo "==== file capabilities (if setcap exists) ====";
  command -v getcap >/dev/null 2>&1 && getcap -r / 2>/dev/null | head -n 200 || true
} > "${SEC}/priv-binaries.txt" 2>&1 || true

# 8) Docker security posture (containers & images)
{
  echo "==== Containers (caps/privileged/seccomp/apparmor) ===="
  docker ps -a -q | while read -r id; do
    docker inspect -f \
'Name={{.Name}} Privileged={{.HostConfig.Privileged}} CapAdd={{.HostConfig.CapAdd}} CapDrop={{.HostConfig.CapDrop}} Seccomp={{.HostConfig.SecurityOpt}} AppArmor={{index .AppArmorProfile}} User={{.Config.User}} Mounts={{range .Mounts}}{{.Type}}:{{.Source}}->{{.Destination}};{{end}}' \
    "$id" 2>/dev/null || true
  done
  echo; echo "==== Image digests & creation ===="
  docker images --digests --format 'REPO={{.Repository}} TAG={{.Tag}} DIGEST={{.Digest}} ID={{.ID}} CREATED={{.CreatedSince}} SIZE={{.Size}}' 2>/dev/null || true
} > "${SEC}/docker-hardening.txt" 2>&1 || true

# 9) One-page rollup
{
  echo "== SECURITY ROLLUP (last 48h window: $SINCE .. now UTC) =="
  echo; echo "-- Failed logins (count) --"; (lastb 2>/dev/null | wc -l || echo 0)
  echo; echo "-- sshd recent errors --"; (command -v journalctl >/dev/null && journalctl -u ssh -u sshd -p err --since="$SINCE" --no-pager | tail -n 50 || true)
  echo; echo "-- sudo errors --"; (command -v journalctl >/dev/null && journalctl _COMM=sudo -p err --since="$SINCE" --no-pager | tail -n 50 || true)
  echo; echo "-- Docker privileged containers --"; grep -c 'Privileged=true' "${SEC}/docker-hardening.txt" 2>/dev/null || echo 0
  echo; echo "-- Listening services --"; (grep -E 'LISTEN|Proto' "${OUT}/ports-summary.txt" 2>/dev/null || true)
} > "${OUT}/security-summary.txt" 2>&1 || true

# Data folders
echo "[*] Copying data folders"
rsync -a --delete "$ROOT_DIR"/data/argon/bot* "$OUT/data" | true

echo "[*] Creating archive"
ARCHIVE="${OUTROOT}.tar.gz"
tar -C "$(dirname "$OUTROOT")" -czf "$ARCHIVE" "$(basename "$OUTROOT")"

echo "[✓] Bundle ready: $ARCHIVE"
