#!/usr/bin/env bash
# ==============================================================================
# MantaPrint Prototype - installer risk acknowledgement
#
# Sourced by install.sh and apps/mantaman/install-mantaman.sh. Shows the
# prototype notice (docs/PROTOTYPE-NOTICE.txt) BEFORE the installer changes
# anything, and only continues when the operator answers y / yes / ya.
#
#   Interactive:      the answer is read from /dev/tty, so it also works
#                     when the installer's stdin is a pipe.
#   Non-interactive:  pass --accept-prototype-risk or set
#                     MANTAPRINT_ACCEPT_RISK=yes. Without a terminal and
#                     without one of those, the installer refuses to run.
#
# The acceptance is recorded as JSON (who, when, how, which notice text).
# ==============================================================================

PG_RED='\033[0;31m'
PG_YELLOW='\033[1;33m'
PG_BOLD='\033[1m'
PG_NC='\033[0m'

_pg_json_escape() {
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\000-\037'
}

_pg_print_notice() {
    local notice_file="$1"
    echo ""
    echo -e "${PG_YELLOW}${PG_BOLD}######################################################################${PG_NC}"
    if [ -f "$notice_file" ]; then
        sed 's/^/  /' "$notice_file"
    else
        echo "  MANTAPRINT PROTOTYPE - NOT FOR PRODUCTION OR SENSITIVE DATA."
        echo "  Known security weaknesses: see docs/KNOWN-LIMITATIONS.md."
        echo "  Provided \"AS IS\", without warranty of any kind (MIT License)."
    fi
    echo -e "${PG_YELLOW}${PG_BOLD}######################################################################${PG_NC}"
    echo ""
}

# prototype_gate <product> <version> <notice_file> <ack_file> [installer args...]
prototype_gate() {
    local product="$1" version="$2" notice_file="$3" ack_file="$4"
    shift 4

    local method=""
    local arg
    for arg in "$@"; do
        [ "$arg" = "--accept-prototype-risk" ] && method="flag"
    done
    if [ -z "$method" ]; then
        case "${MANTAPRINT_ACCEPT_RISK:-}" in
            y|Y|yes|YES|Yes|ya|YA|Ya|1|true|TRUE) method="env" ;;
        esac
    fi

    if [ -z "$method" ]; then
        # Open the controlling terminal; fails when there is none (CI, cloud-init, pipes without a tty).
        # The notice and the prompt go straight to the tty, so they still work when the installer's
        # output is piped (e.g. "| tee install.log"). No whiptail: it cannot take over the keyboard then.
        if ! { exec 3<>/dev/tty; } 2>/dev/null; then
            echo -e "${PG_RED}[ABORTED] ${product} is a PROTOTYPE and needs an explicit risk acknowledgement.${PG_NC}"
            echo "  No terminal is available to ask for it. Read docs/PROTOTYPE-NOTICE.txt, then re-run with"
            echo "  --accept-prototype-risk (or MANTAPRINT_ACCEPT_RISK=yes). Nothing was changed."
            exit 1
        fi

        _pg_print_notice "$notice_file" >&3

        local answer=""
        printf "%b" "${PG_BOLD}Install ${product} ${version} at your own risk? Type y / yes / ya to continue: ${PG_NC}" >&3
        IFS= read -r answer <&3 || answer=""
        exec 3>&-
        answer="$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
        case "$answer" in
            y|yes|ya) method="interactive" ;;
            *)
                echo -e "${PG_RED}[ABORTED] Risk not accepted. Nothing was changed.${PG_NC}"
                exit 1
                ;;
        esac
    else
        _pg_print_notice "$notice_file"
        echo -e "${PG_YELLOW}[NOTICE] Prototype risk accepted non-interactively (${method}).${PG_NC}"
    fi

    local notice_sha="unavailable"
    if [ -f "$notice_file" ] && command -v sha256sum >/dev/null 2>&1; then
        notice_sha="$(sha256sum "$notice_file" | awk '{print $1}')"
    fi

    mkdir -p "$(dirname "$ack_file")"
    cat > "$ack_file" <<EOF
{
  "product": "$(_pg_json_escape "$product")",
  "version": "$(_pg_json_escape "$version")",
  "channel": "prototype",
  "accepted": true,
  "accepted_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "method": "${method}",
  "accepted_by": "$(_pg_json_escape "${SUDO_USER:-${USER:-root}}")",
  "hostname": "$(_pg_json_escape "$(hostname 2>/dev/null || echo unknown)")",
  "notice_sha256": "${notice_sha}"
}
EOF
    chmod 644 "$ack_file"
    echo "  Risk acknowledgement recorded in ${ack_file}"
    echo ""
}

# prototype_post_notice <product> <admin_user> <admin_password>
prototype_post_notice() {
    local product="$1" admin_user="$2" admin_password="$3"
    echo -e "${PG_YELLOW}${PG_BOLD}######################################################################${PG_NC}"
    echo -e "${PG_YELLOW}${PG_BOLD}  REMINDER: ${product} IS A PROTOTYPE - NOT FOR PRODUCTION${PG_NC}"
    echo -e "${PG_YELLOW}${PG_BOLD}######################################################################${PG_NC}"
    echo "  Before anyone else uses this device:"
    echo "   1. Change the default admin password (${admin_user} / ${admin_password}) now."
    echo "   2. Keep it on an isolated lab / test network, never internet-facing."
    echo "   3. Allow access only from trusted machines (firewall / VLAN ACL)."
    echo "   4. Do not process personal or sensitive documents with it."
    echo "   5. Traffic is plain HTTP: assume anything sent to it can be read."
    echo "  Known weaknesses: docs/KNOWN-LIMITATIONS.md   Reporting: SECURITY.md"
    echo "  Provided \"AS IS\", without warranty of any kind. You operate it at your own risk."
    echo -e "${PG_YELLOW}${PG_BOLD}######################################################################${PG_NC}"
}
