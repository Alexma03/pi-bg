#!/usr/bin/env bash
# Fake `orca` CLI for bridge tests. State lives in $FAKE_ORCA_DIR:
#   run.json        stdout for `orchestration run-current --json`
#   queue/NNN.json  responses for `check`, consumed in name order
#   calls.log       one line per invocation (argv)
#   workers.json / tasks.json  stdout for worker-list / task-list
# A `check --wait` with an empty queue sleeps until one appears (or 5 s,
# then answers timedOut), like the real waiter.
set -u
dir="$FAKE_ORCA_DIR"
echo "$*" >> "$dir/calls.log"
if [[ "$1 $2" == "orchestration run-current" ]]; then
	cat "$dir/run.json"
	exit 0
fi
if [[ "$1 $2" == "orchestration worker-list" ]]; then
	cat "$dir/workers.json" 2>/dev/null || echo '{"ok":true,"result":{"workers":[],"page":{"hasMore":false,"nextCursor":null}}}'
	exit 0
fi
if [[ "$1 $2" == "orchestration task-list" ]]; then
	cat "$dir/tasks.json" 2>/dev/null || echo '{"ok":true,"result":{"tasks":[]}}'
	exit 0
fi
if [[ "$1 $2" == "orchestration check" ]]; then
	wait=0
	for arg in "$@"; do [[ "$arg" == "--wait" ]] && wait=1; done
	for _ in $(seq 1 100); do
		next=$(ls "$dir/queue" 2>/dev/null | sort | head -n1)
		if [[ -n "$next" ]]; then
			cat "$dir/queue/$next"
			rm -f "$dir/queue/$next"
			exit 0
		fi
		[[ $wait == 1 ]] || break
		sleep 0.05
	done
	echo '{"ok":true,"result":{"runId":"run_fake","deliveryId":null,"messages":[],"count":0,"acknowledged":null,"timedOut":true,"cancelled":false,"connectionLost":false}}'
	exit 0
fi
echo '{"ok":false,"error":{"code":"unknown_command","message":"fake"}}'
exit 1
