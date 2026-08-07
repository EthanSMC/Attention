# Attention staging deployment runbook

This runbook deploys Attention staging at `attention-staging.noveltystudio.cn`
without sharing ports, Compose resources, data, or secrets with Novelty QA.
Run commands from `/opt/attention-staging/app` unless a section says otherwise.

## Fixed deployment contract

| Item | Required value |
| --- | --- |
| Public hostname | `attention-staging.noveltystudio.cn` |
| Web upstream | `127.0.0.1:9199` |
| Source checkout | `/opt/attention-staging/app` |
| Environment file | `/etc/attention-staging/compose.env` |
| PostgreSQL data | `/data/attention-staging/postgres` |
| Backups | `/data/attention-staging/backups` |
| Release state | `/var/lib/attention-staging` |
| Compose project | `attention-staging` |
| Existing Novelty QA listener | host port `9099` — do not stop or modify |

Attention PostgreSQL and Fetcher must never have public listeners. In the
default deployment, the only application port published by Compose is the Web
listener on loopback `127.0.0.1:9199`; Nginx is its only public entry point. If
the optional WeChat profile is enabled later, it adds only the loopback listener
`127.0.0.1:9299` and still must not be exposed by a public security-group rule.

## Pre-deployment security gate

The pre-deployment observation on 2026-08-05 was:

- public TCP `5432` was reachable;
- TCP `80` and `443` were reachable, but neither served a valid Attention HTTP
  virtual host or valid TLS endpoint;
- host `nginx.service` and `caddy.service` were inactive;
- `9099` belonged to the existing Novelty QA service.

Resolution evidence recorded on 2026-08-05:

- an explicit Alibaba Cloud IPv4 deny rule was added for public TCP `5432`;
- Google Public DNS and Cloudflare DNS both resolved the staging hostname to
  `8.130.120.74`;
- five independent external TCP probes timed out when connecting to `5432`.

This evidence closes the observed blocker; it does not make the rule
permanent. **Do not deploy if a fresh external check can reach public port
`5432`.** TCP reachability on `80`/`443` alone is not proof that HTTP or TLS is
configured. Save the security group change ticket and each successful external
surface check as deployment evidence.

## 1. Close the public surface first

In the Alibaba Cloud ECS security group, review both IPv4 and IPv6 rules and
any broad port ranges:

1. Allow inbound TCP `80` and `443` from the Internet. Add IPv6 rules only if
   the DNS name has an AAAA record and the host is deliberately serving IPv6.
2. Restrict TCP `22` to the administrator's fixed office/VPN CIDRs.
3. Remove every public rule that includes TCP `5432`, including an `all ports`
   rule. Attention does not use the host PostgreSQL listener.
4. Do not add inbound rules for `9199`, `4100`, or `9299`.
5. Record `9099` as the pre-existing Novelty QA exception. Its warning does not
   block this deployment, and this procedure must not change that service.

Do not blindly enable a host firewall: an unreviewed rule can disconnect SSH or
Novelty QA. If defense-in-depth host rules are required, have the host owner
review them against the same port matrix.

Save the reviewed rule set and change ticket. The complete external surface
gate runs after Nginx/TLS is active, when `80` and `443` have real listeners.

## 2. Publish and verify DNS

Create an A record for `attention-staging.noveltystudio.cn` pointing to the ECS
public IPv4 address. Remove a stale AAAA record unless the host and security
group are intentionally configured for IPv6. From an external machine:

```bash
dig +short A attention-staging.noveltystudio.cn
dig +short AAAA attention-staging.noveltystudio.cn
```

Compare the A result with the ECS console. Wait for public resolvers to return
the intended address. Then prove from outside the ECS/VPC that PostgreSQL is no
longer reachable before doing any server deployment work:

```bash
if nc -z -w 3 attention-staging.noveltystudio.cn 5432; then
  echo 'BLOCKED: public PostgreSQL is still reachable' >&2
  exit 1
fi
```

This negative check must complete successfully. A reachable `5432` is a hard
failure; stop and correct the security group before continuing.

## 3. Prepare directories and a clean source checkout

Create the fixed paths. The release scripts run as root so they can read the
mode-`0600` environment file and manage Docker; keep the checkout root-owned as
well. This avoids Git's dubious-ownership protection and prevents an
unprivileged account from changing code between preflight and build.

```bash
sudo apt-get update
sudo apt-get install --yes curl git iproute2 python3
sudo install -d -o root -g root -m 0755 /opt/attention-staging/app
sudo install -d -o root -g root -m 0700 /etc/attention-staging
sudo install -d -o root -g root -m 0750 /data/attention-staging
sudo install -d -o root -g root -m 0700 /data/attention-staging/postgres
sudo install -d -o root -g root -m 0700 /data/attention-staging/backups
sudo install -d -o root -g root -m 0700 /var/lib/attention-staging
```

Use the host's approved Docker installation; do not replace or reconfigure its
daemon during this change window because Novelty QA also depends on it. The
target baseline is Docker Engine 29 with Docker Compose 5. Confirm both clients
and the daemon respond before copying the release. The host was verified on
2026-08-05 with PostgreSQL client `17.10`. Confirm the client tools are still
major version 17. If they are missing or no longer on major 17, install
`postgresql-client-17` from the host owner's approved Debian or PGDG repository
before continuing; do not add an unreviewed package source during this change
window. `pg_restore` must not be older than the database image:

```bash
sudo docker version >/dev/null
sudo docker compose version >/dev/null
pg_dump --version | grep -E '^pg_dump \(PostgreSQL\) 17\.'
pg_restore --version | grep -E '^pg_restore \(PostgreSQL\) 17\.'
```

Populate `/opt/attention-staging/app` through the approved release checkout
workflow. Deploy a reviewed commit, not an ad-hoc working tree. If the release
was copied by a non-root operator, transfer ownership only after the copy is
complete, before validation. Copy the full reviewed commit SHA from the release
ticket into the root-owned approval record; do not derive this value blindly
from the checkout being approved. Then verify both identity and cleanliness:

```bash
sudo chown -R -- root:root /opt/attention-staging/app
read -r -p 'Reviewed full release commit SHA: ' attention_release_sha
[[ "$attention_release_sha" =~ ^[a-f0-9]{40,64}$ ]]
printf '%s\n' "$attention_release_sha" | \
  sudo tee /var/lib/attention-staging/expected-release >/dev/null
sudo chown root:root /var/lib/attention-staging/expected-release
sudo chmod 0600 /var/lib/attention-staging/expected-release
unset attention_release_sha
sudo git -C /opt/attention-staging/app rev-parse --verify HEAD >/dev/null
test -z "$(sudo git -C /opt/attention-staging/app status --porcelain)"
test "$(sudo sed -n '1p' /var/lib/attention-staging/expected-release)" = \
  "$(sudo git -C /opt/attention-staging/app rev-parse HEAD)"
```

If the second command fails, stop. Do not discard or overwrite unexplained
changes on the server.

## 4. Generate the environment file once

Generate a root-readable file. The generator refuses to overwrite an existing
file and does not print generated values.

```bash
cd /opt/attention-staging/app
sudo ./deploy/staging/generate-env.sh /etc/attention-staging/compose.env
sudo stat -c '%U:%G %a %n' /etc/attention-staging/compose.env
```

The expected owner/mode is `root:root 600`. Use `sudoedit` to replace only the
external-provider placeholders; never use `cat`, shell tracing, or a command
that echoes the file:

```bash
sudoedit /etc/attention-staging/compose.env
sudo ./deploy/staging/validate-env.sh /etc/attention-staging/compose.env
```

If this environment file predates the Local Channel Runtime, add a newly
generated `ATTENTION_CHANNEL_PAIRING_SECRET` with `sudoedit` before validation.
Do not copy an existing application secret into that field.

Before validation, confirm operationally that:

- `RESEND_API_KEY` is a newly rotated key; revoke any key previously pasted
  into chat or a ticket;
- `service.noveltystudio.cn` is a verified Resend sending domain and the From
  address is authorized;
- the published template alias is `attention-login-code`, accepts only
  `verification_code` and `valid_minutes`, and uses neutral copy that does not
  reveal whether an account exists;
- `ATTENTION_DIGEST_WORKER_ENABLED=false` for the first deployment;
- the obsolete `ATTENTION_AUTH_EXPOSE_OTP` setting is absent;
- `ATTENTION_CHANNEL_PAIRING_SECRET` retains the generator's independent
  random value and does not reuse the Auth, legacy Channel, or Adapter secret;
- the generated domain, Compose project, loopback bind, port, and `/data` paths
  retain the fixed values in this runbook.

The validator reports variable names only. Treat any validation failure as a
stop condition; do not weaken the validator to make a deployment pass.
It also rejects duplicate keys, parses all three PostgreSQL URLs exactly, and
requires `ATTENTION_TRUSTED_CLIENT_SOURCE_HEADER=x-attention-client-source` so
the Web trust boundary cannot drift away from the Nginx-owned header.

## 5. Preflight and deploy

Keep Novelty QA running throughout. The staging scripts fix the Compose project
name, env-file path, and base/overlay file order; use them instead of hand-built
Compose commands.

```bash
cd /opt/attention-staging/app
sudo ./deploy/staging/preflight.sh
sudo ./deploy/staging/deploy.sh
sudo ./deploy/staging/smoke-test.sh
```

The deployment takes a non-blocking host operation lock. On upgrades it checks
the existing PostgreSQL container without pulling or recreating it, validates
the recorded schema head, stops only the Attention Web/Worker/Fetcher, backs up
the database, and proves that backup restores in a disposable network-isolated
PostgreSQL 17 container. Only then does it build application images serially,
apply forward-only migrations, and wait for services to become healthy. A first
deployment has no prior database to back up.

Application builds currently run on this ECS because no deployment registry has
been selected. Runtime Compose CPU/memory limits do not constrain BuildKit, so
preflight requires at least 3 GiB available memory, application builds are
serialized, and an existing Attention application is stopped before the build.
Novelty QA must remain healthy on `9099` before and after the operation. If this
gate cannot be met, build immutable images in CI, push them to an approved
registry, and deploy by digest instead of weakening the resource check.

The loopback health endpoint must pass before Nginx is enabled:

```bash
curl --fail --silent --show-error \
  --header 'Host: attention-staging.noveltystudio.cn' \
  http://127.0.0.1:9199/api/health >/dev/null
```

If port `9199` is occupied by an unrelated process, or appears on any address
other than `127.0.0.1`, stop. Do not kill the process or change the staging port
to work around the collision.

The deploy records both release IDs and database schema heads. If a migration
succeeds but a later smoke check fails, the next deploy fails closed because
the live schema no longer matches the last successful record. Do not delete or
rewrite the record to force a retry; review the migration/app compatibility and
choose an approved forward fix or recovery procedure.

## 6. Install the HTTP Nginx virtual host

Only Nginx should own public `80`/`443`. Do not enable Caddy alongside it. On a
Debian/Ubuntu host:

```bash
sudo ss -H -lntp | awk '$4 ~ /:(80|443|9099|9199)$/ { print }'
sudo apt-get update
sudo apt-get install --yes nginx certbot python3-certbot-nginx
systemctl is-active nginx || true
systemctl is-active caddy || true
sudo test ! -e /etc/nginx/conf.d/attention-staging.conf
sudo install -o root -g root -m 0644 \
  /opt/attention-staging/app/deploy/staging/nginx/attention-staging.conf \
  /etc/nginx/conf.d/attention-staging.conf
sudo nginx -t
sudo systemctl enable --now nginx
```

The first command may show Novelty QA on `9099` and Attention Web on loopback
`9199`. If an unidentified process owns `80` or `443`, stop and identify its
service owner; do not kill it or make Nginx compete for the port. This baseline
virtual host is IPv4-only. Serving IPv6 requires a separately reviewed AAAA
record, IPv6 security-group rules, and matching Nginx listeners.

If the target file already exists, the `test` command stops this sequence.
Review the installed file and any Certbot changes instead of overwriting it.
The bootstrap configuration:

- proxies only to `127.0.0.1:9199`;
- replaces caller-supplied `X-Attention-Client-Source` with the connection
  source and also overwrites forwarding identity/scheme headers;
- rate-limits `/api/auth/` and applies a stricter limit to `/oauth/register`;
- sets a 2 MiB body ceiling and bounded client/upstream timeouts;
- does not expose PostgreSQL, Fetcher, or the WeChat adapter.

Test virtual-host routing locally, then from an external machine:

```bash
curl --fail --silent --show-error \
  --resolve attention-staging.noveltystudio.cn:80:127.0.0.1 \
  http://attention-staging.noveltystudio.cn/api/health >/dev/null
curl --fail --silent --show-error \
  http://attention-staging.noveltystudio.cn/api/health >/dev/null
```

Do not continue to Certbot until the external HTTP request succeeds and DNS
points at this host.

## 7. Bootstrap TLS with Certbot

Supply an operator-owned renewal email at execution time. The command edits the
installed Nginx file, adds the certificate, and enables an automatic HTTP to
HTTPS redirect.

```bash
read -r -p 'Certbot operator email: ' attention_certbot_email
sudo certbot --nginx --non-interactive --agree-tos --redirect \
  --email "$attention_certbot_email" \
  --domains attention-staging.noveltystudio.cn
unset attention_certbot_email
sudo nginx -t
sudo systemctl reload nginx
```

After Certbot succeeds, the installed file is Certbot-managed state. Do not
recopy the HTTP bootstrap file over it during later application deployments.
Review and merge future proxy changes, run `nginx -t`, and only then reload.

Verify the renewal timer and a dry-run renewal:

```bash
sudo systemctl enable --now certbot.timer
sudo systemctl is-enabled --quiet certbot.timer
sudo systemctl is-active --quiet certbot.timer
sudo systemctl list-timers certbot.timer --no-pager
sudo certbot renew --dry-run
```

Then verify HTTPS and the HTTP redirect from an external machine:

```bash
curl --fail --silent --show-error \
  https://attention-staging.noveltystudio.cn/api/health >/dev/null
test "$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  http://attention-staging.noveltystudio.cn/api/health)" = 301
./deploy/staging/check-public-surface.sh attention-staging.noveltystudio.cn
```

A successful HTTPS request plus a passing public-surface check is required.
The expected `9099` warning remains non-blocking; do not “fix” it in this
change window.

## 8. Acceptance checks

Record the deployed Git commit, security-group ticket, DNS results, Nginx syntax
result, certificate expiry, and script exit results in the deployment ticket.
Do not attach the environment file or expanded Compose configuration.

Run the repository-provided checks:

```bash
cd /opt/attention-staging/app
sudo ./deploy/staging/preflight.sh
sudo ./deploy/staging/smoke-test.sh --public
curl --fail --silent --show-error \
  https://attention-staging.noveltystudio.cn/api/health >/dev/null
```

Acceptance requires all of the following:

- `https://attention-staging.noveltystudio.cn/api/health` succeeds with a valid
  public certificate and HTTP redirects to HTTPS;
- Web remains reachable on host loopback only at `127.0.0.1:9199`;
- public `5432`, `9199`, `4100`, and `9299` are unreachable;
- the `attention-staging` services are healthy and the Novelty QA service on
  `9099` remained uninterrupted;
- no secret value appears in the ticket, terminal transcript, or repository.

### Synthetic email OTP login

Use a dedicated QA mailbox supplied only at test time; do not add it to the env
file, repository, ticket, or shell history. In a private browser window:

1. Open `https://attention-staging.noveltystudio.cn/login` and enter the QA
   mailbox in the email-code flow.
2. Confirm the UI advances without revealing whether the mailbox already has
   an account.
3. Confirm exactly one message arrives from the verified Attention sender. The
   neutral `attention-login-code` template must have both variables rendered,
   must not reveal account existence, and should state the 10-minute validity.
4. Enter the received code in the browser. Complete terms consent if this is a
   new staging-only account, and confirm the authenticated page loads.
5. Sign out and confirm reusing the same code fails. Do not paste the code into
   logs, chat, tickets, or command arguments.

Failure to deliver, unresolved template variables, an invalid sender, or an OTP
exposed in the HTTP response is a release blocker. Do not switch to the console
provider or reintroduce OTP response exposure as a workaround.

## 9. Backup and application rollback

Create an additional on-demand backup before risky operational work:

```bash
cd /opt/attention-staging/app
attention_backup_path=$(sudo ./deploy/staging/backup.sh)
sudo ./deploy/staging/restore-drill.sh "$attention_backup_path"
unset attention_backup_path
sudo find /data/attention-staging/backups -maxdepth 1 -type f \
  -printf '%TY-%Tm-%TdT%TH:%TM:%TSZ %s %f\n' | sort
```

The backup script writes a non-empty PostgreSQL custom-format backup with mode
`0600` and retains at most 14 successful staging backups. The restore drill
creates an explicit temporary Docker container and volume with no network,
restores the dump, verifies the required schema, and removes only those
temporary resources. The listing prints only timestamps, sizes, and
filenames—not database contents.

Application rollback is non-destructive and requires an explicit, already-built
prior release ID recorded by the deployment process:

```bash
cd /opt/attention-staging/app
attention_previous_release=$(sudo sed -n '1p' /var/lib/attention-staging/previous-release)
sudo ./deploy/staging/rollback-app.sh "$attention_previous_release"
unset attention_previous_release
sudo ./deploy/staging/smoke-test.sh
curl --fail --silent --show-error \
  https://attention-staging.noveltystudio.cn/api/health >/dev/null
```

Before running it, compare the recorded previous release with the deployment
ticket; do not guess or use an unreviewed release. The script accepts only that
exact previous release and requires its recorded schema head to equal the live
database. If any migration advanced the schema, application rollback is blocked
instead of relying on a liveness-only check. Allowed rollbacks must also pass the
database-backed discovery-page smoke test and leave the same Novelty QA
container healthy. Database restore is a separate incident procedure: it
requires an approved outage, a fresh backup of the current database, a verified
custom-format backup, and a release/database compatibility decision. Do not
restore over the live database as part of routine application rollback.

## Prohibited operations

Never run any of the following in this deployment or rollback:

- `docker compose down -v`, `docker volume rm`, or `docker system prune`;
- ad-hoc Compose commands that omit project `attention-staging`, the fixed env
  file, or either the base/staging Compose file;
- `docker compose config` without `--quiet`, because rendered configuration can
  expose secrets;
- `set -x`, `cat /etc/attention-staging/compose.env`, `printenv`, or any command
  that copies environment values into logs, chat, tickets, or the repository;
- publishing or opening `5432`, `9199`, `4100`, or `9299` to the Internet;
- changing `WEB_BIND_ADDRESS` from `127.0.0.1`, changing the Compose project
  name, or sharing Novelty QA volumes/networks;
- stopping, restarting, rebinding, or reconfiguring the service on `9099`;
- enabling Caddy while Nginx owns `80`/`443`;
- overwriting the Certbot-managed Nginx file with the HTTP bootstrap file;
- treating application rollback as a database downgrade or restoring a backup
  over live data without a separately approved recovery plan.

When a command fails, stop at that gate, preserve the output that contains no
secrets, and investigate. Do not weaken isolation, validation, or backup checks
to continue a deployment.
