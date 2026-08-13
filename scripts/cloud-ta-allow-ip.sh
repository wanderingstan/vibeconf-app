#!/usr/bin/env bash
# Re-point the cloud-TA security group's SSH rule at wherever you are right now.
#
# The box (i-0e7b0ce1bbafe24d0) only accepts SSH from an explicit IP allowlist, so
# moving between coffee shops / home / tethering locks you out. Run this after moving.
#
#   ./scripts/cloud-ta-allow-ip.sh            # replace the allowlist with your current IP
#   ./scripts/cloud-ta-allow-ip.sh --add      # keep existing entries, just add this one
#
# The real fix is SSM Session Manager (port 22 closed entirely, no allowlist at all).
# See the cloud TA tracking issue. This is the stopgap until that's set up.
set -euo pipefail

PROFILE="${AWS_PROFILE:-vibeconf-ta}"
REGION="us-east-2"
SG="sg-04bb8444a7e2df64b"

MYIP="$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]')"
[ -n "$MYIP" ] || { echo "could not determine public IP" >&2; exit 1; }
echo "current public IP: $MYIP"

existing="$(aws ec2 describe-security-groups --profile "$PROFILE" --region "$REGION" \
  --group-ids "$SG" \
  --query 'SecurityGroups[0].IpPermissions[?ToPort==`22`].IpRanges[].CidrIp' --output text)"

if [ "${1:-}" != "--add" ]; then
  for cidr in $existing; do
    [ "$cidr" = "$MYIP/32" ] && continue
    echo "revoking $cidr"
    aws ec2 revoke-security-group-ingress --profile "$PROFILE" --region "$REGION" \
      --group-id "$SG" --protocol tcp --port 22 --cidr "$cidr" >/dev/null
  done
fi

if echo "$existing" | tr '\t' '\n' | grep -qx "$MYIP/32"; then
  echo "already allowed: $MYIP/32"
else
  aws ec2 authorize-security-group-ingress --profile "$PROFILE" --region "$REGION" \
    --group-id "$SG" --protocol tcp --port 22 --cidr "$MYIP/32" >/dev/null
  echo "allowed: $MYIP/32"
fi

echo "current SSH allowlist:"
aws ec2 describe-security-groups --profile "$PROFILE" --region "$REGION" --group-ids "$SG" \
  --query 'SecurityGroups[0].IpPermissions[?ToPort==`22`].IpRanges[].CidrIp' --output text
