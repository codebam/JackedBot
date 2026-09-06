#!/usr/bin/env bash
# =============================================================================
# Push the three secrets Cloudflare needs. Run once per environment.
#
#   ./scripts/set-secrets.sh            # interactive, prompts for blanks
#   ./scripts/set-secrets.sh --from-dev-vars   # copy values out of .dev.vars
#
# Nothing here is a value you get from a vendor except TELEGRAM_BOT_TOKEN:
#
#   TELEGRAM_BOT_TOKEN          -> @BotFather  (/newbot, or /token for an existing bot)
#   APP_SECRET                  -> you generate it.  Signs WebSocket tickets.
#   TELEGRAM_WEBHOOK_SECRET     -> you generate it.  NOT from Telegram. You choose
#                                  the value, store it as a secret, then hand the
#                                  SAME string to Telegram with
#                                  `npm run telegram:webhook`, which passes it as
#                                  setWebhook's `secret_token`. Telegram then
#                                  sends it back in the
#                                  X-Telegram-Bot-Api-Secret-Token header on every
#                                  delivery, and the webhook route compares it.
#                                  It is what stops anyone who discovers your
#                                  workers.dev URL from POSTing fake
#                                  "successful_payment" updates and minting chips.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

SECRET_NAMES=(TELEGRAM_BOT_TOKEN APP_SECRET TELEGRAM_WEBHOOK_SECRET)

random_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  fi
}

value_for() {
  local key="$1"
  if [[ "${1:-}" == "--from-dev-vars" ]]; then :; fi
  # Prefer an existing .dev.vars entry so local and prod match during bring-up.
  if [[ -f .dev.vars ]]; then
    local existing
    existing="$(grep -E "^${key}=" .dev.vars | tail -1 | cut -d= -f2- || true)"
    if [[ -n "$existing" ]]; then
      printf '%s' "$existing"
      return
    fi
  fi
  case "$key" in
    TELEGRAM_BOT_TOKEN)
      read -rp "Paste TELEGRAM_BOT_TOKEN from @BotFather: " v ;;
    APP_SECRET|TELEGRAM_WEBHOOK_SECRET)
      local gen; gen="$(random_secret)"
      printf 'Generated a value for %s (save it, and keep it out of git): %s\n' "$key" "$gen" >&2
      read -rp "Press enter to use it, or paste your own: " v
      v="${v:-$gen}" ;;
  esac
  printf '%s' "$v"
}

if [[ "${1:-}" == "--from-dev-vars" ]]; then
  for name in "${SECRET_NAMES[@]}"; do
    val="$(grep -E "^${name}=" .dev.vars | tail -1 | cut -d= -f2- || true)"
    if [[ -z "$val" || "$val" == \#* ]]; then
      echo "skip ${name} (not present in .dev.vars)"
      continue
    fi
    echo "setting ${name} from .dev.vars"
    printf '%s' "$val" | npx wrangler secret put "$name"
  done
else
  for name in "${SECRET_NAMES[@]}"; do
    val="$(value_for "$name")"
    printf '%s' "$val" | npx wrangler secret put "$name"
  done
fi

cat <<'EOF'

Secrets uploaded. Next:
  npm run deploy                     # build + publish (fills in D1/DO bindings)
  npm run telegram:webhook           # registers the webhook AND sends the secret
                                     # token you just set — do not skip this, the
                                     # Worker rejects deliveries without the header.
EOF
