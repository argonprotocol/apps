# Validate required variables
if [ -z "$logs_dir" ]; then
    echo "Error: logs_dir variable must be set before sourcing this script"
    return 1
fi

akey=""

# Create logs directory if it doesn't exist
mkdir -p "$logs_dir"

########################################################
# Helper functions
########################################################

parse_plain_progress() {
    local progress_file="$1"
    local line cur tot

    while IFS= read -r line; do
        # Match either "[3/9]" or "[service 3/9]"
        if [[ $line =~ \[([0-9]+)\/([0-9]+)\] ]]; then
            cur="${BASH_REMATCH[1]}"; tot="${BASH_REMATCH[2]}"
        elif [[ $line =~ \[[^[:space:]]+[[:space:]]+([0-9]+)\/([0-9]+)\] ]]; then
            cur="${BASH_REMATCH[1]}"; tot="${BASH_REMATCH[2]}"
        else
            continue
        fi
        if (( tot > 0 )); then
            printf '%d\n' $(( (cur * 100) / tot )) > "$progress_file"
        fi
    done
}

parse_json_progress() {
    local progress_file="$1"
    jq -r '
        foreach inputs as $in ( {progress:{}, last:0};
         # update per-layer current/total when available
         if ($in.current | type) == "number" and ($in.total | type) == "number" and $in.total > 0 then
             .progress[$in.id].current = ($in.current // .progress[$in.id].current // 0)
             | .progress[$in.id].total = ($in.total   // .progress[$in.id].total   // 0)
         elif ($in.progressDetail.current | type) == "number" and ($in.progressDetail.total | type) == "number" and $in.progressDetail.total > 0 then
             .progress[$in.id].current = ($in.progressDetail.current // .progress[$in.id].current // 0)
             | .progress[$in.id].total = ($in.progressDetail.total   // .progress[$in.id].total   // 0)
         elif ($in.id? and (.progress[$in.id].total | not)) then
             .progress[$in.id].total = (5 * 1024 * 1024 * 1024)   # 5 GB guess
         else
             .
         end;

         # compute weighted percent across all known layers (sum currents / sum totals)
         (.progress | to_entries | map(.value.current // 0) | add) as $sumCurrent
         | (.progress | to_entries | map(.value.total // 0) | add) as $sumTotal
         | (if $sumTotal > 0 then (($sumCurrent * 100) / $sumTotal) else 0 end) as $cur
         | if $cur > .last then .last = $cur else . end
         | .last
        )
      ' --unbuffered \
      | while read pct; do
          if [[ -n "$pct" && "$pct" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
              printf '%s\n' "$pct" > "$progress_file"
          fi
        done
}

run_compose() {
    command=$1
     # Log the command being run
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] % $command" >> "$logs_dir/step-$akey.log"
    # Use eval to properly handle command with arguments
    # Create a temporary file to capture output
    stdout_file=$(mktemp)
    clean_cmd=$(echo "$command" \
      | sed -E 's/^docker compose[ ]*//' \
      | awk '{for (i=1; i<=NF; i++) if ($i !~ /^-/) printf "%s ", $i; print ""}' \
      | xargs)   # normalize spaces and remove args
    slug=$(echo "$clean_cmd" | tr -cs '[:alnum:]' '-' | sed 's/^-*//;s/-*$//')
    progress_file="$logs_dir/step-$akey.progress-$slug.json"

    if [[ "$command" == *" build"* ]]; then
      # Insert --progress=plain immediately after 'docker compose'
      command=$(echo "$command" | sed -E 's/^(docker compose)([ ]*)/\1 --progress=plain\2/')
    fi
    if [[ "$command" == *" pull"* ]]; then
      # Insert --progress=json immediately after 'docker compose'
      command=$(echo "$command" | sed -E 's/^(docker compose)([ ]*)/\1 --progress=json\2/')
    fi

    log_file="$logs_dir/step-$akey.log"
    if [[ "$command" == *"--progress=json"* ]]; then
       bash -c "$command" 2>&1 \
         | tee -a "$log_file" \
         | tee "$stdout_file" \
         | grep -E '^[[:space:]]*\{' \
         | parse_json_progress "$progress_file"
    elif [[ "$command" == *"--progress=plain"* ]]; then
       bash -c "$command" 2>&1 \
         | tee "$stdout_file" \
         | tee -a "$log_file" \
         | parse_plain_progress "$progress_file"
    else
       bash -c "$command" 2>&1 \
         | tee -a "$log_file" \
         > "$stdout_file"
    fi

    command_exit_status=${PIPESTATUS[0]}

    if [ $command_exit_status -ne 0 ]; then
        rm "$stdout_file"
        failed "Command \"$command\" failed with exit status $command_exit_status"
    fi

    if grep -q "no configuration file provided: not found" "$stdout_file"; then
        failed "no configuration file provided: not found"
    fi
    # Return the captured output
    cat "$stdout_file"
    rm "$stdout_file"
}

run_command() {
    command=$1
    # Log the command being run
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] % $command" >> "$logs_dir/step-$akey.log"
    # Use eval to properly handle command with arguments
    # Create a temporary file to capture output
    stdout_file=$(mktemp)

    eval "$command" 2>&1 | tee -a "$logs_dir/step-$akey.log" > "$stdout_file"
    command_exit_status=${PIPESTATUS[0]}

    if [ $command_exit_status -ne 0 ]; then
        rm "$stdout_file"
        failed "Command \"$command\" failed with exit status $command_exit_status"
    fi
    # Return the captured output
    cat "$stdout_file"
    rm "$stdout_file"
}

log_to_file() {
    echo "$1" | tee -a "$logs_dir/step-$akey.log"
}

fetch_log_contents() {
    lines=${1:-100}  # Default to 100 if no argument provided
    tail -n $lines "$logs_dir/step-$akey.log"
}

start() {
    step_name=$1
    if [ ! -z "$akey" ]; then
        echo "Error: akey is already set"
        exit 1
    fi
    akey=$step_name
    filepath="${logs_dir}/step-$step_name.Started"
    if [ -f "$filepath" ]; then
        echo "Error: $filepath already exists"
        exit 1
    fi
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] STARTED" >> "$filepath"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] STARTED $step_name"
}

reset() {
    step_name=$1
    rm "${logs_dir}/step-$step_name.Started"
    rm "${logs_dir}/step-$step_name.Finished"
    rm "${logs_dir}/step-$step_name.Failed"
    rm "${logs_dir}/step-$step_name.log"
}

finish() {
    step_name=$1
    command_output=$2
    if [ "$step_name" != "$akey" ]; then
        echo "Error: step_name ($step_name) does not match current akey ($akey) in finished()"
        exit 1
    fi
    akey=""
    if [ ! -z "$command_output" ]; then
        echo "$command_output" >> "${logs_dir}/step-$step_name.Finished"
    else
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] FINISHED" >> "${logs_dir}/step-$step_name.Finished"
    fi
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] FINISHED $step_name"
}

failed() {
    error_message=$1
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $error_message" >> "${logs_dir}/step-$akey.Failed"
    exit 1
}

already_ran() {
    step_name=$1
    finished_filepath="${logs_dir}/step-$step_name.Finished"
    [ -f "$finished_filepath" ]
}
