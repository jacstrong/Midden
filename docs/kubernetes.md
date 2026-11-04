# Running on Kubernetes

Midden has a Helm chart. It runs one pod with one persistent volume, and that is deliberate.

## One pod, on purpose

Midden keeps its data in SQLite on a single volume and its live case rooms in memory. Two pods would corrupt the database or split analysts into rooms that can't see each other, so the chart has no replica count and no autoscaling, and refuses values that try to set them. Upgrades stop the old pod before starting the new one, which means a short outage.

Kubernetes still gives you restarts, rescheduling, ingress and secrets, but not high availability. If the node holding the volume goes down, Midden is down until the volume can attach elsewhere. Its [design point](deploy.md#sizing) is twenty concurrent analysts on one case, which one pod handles comfortably.

## Install

```bash
helm install midden oci://ghcr.io/jacstrong/midden/charts/midden \
  --namespace midden --create-namespace \
  --version 1.3.0 \
  --set ingress.enabled=true \
  --set ingress.host=midden.corp.example \
  --set ingress.tlsSecretName=midden-tls
```

Get the first admin's one-time password from the log, then sign in and change it:

```bash
kubectl logs -n midden deploy/midden | grep 'one-time password'
```

To check the install, run `helm test midden -n midden`.

To set the first admin's password yourself, create a secret with a `password` key and set `admin.existingSecret` to its name.

Every option is described in [`values.yaml`](../charts/midden/values.yaml). To print them for a published version, run `helm show values oci://ghcr.io/jacstrong/midden/charts/midden`.

## Getting traffic in

Set either `ingress.enabled` or, for the Gateway API, `httpRoute.enabled` with `httpRoute.parentRefs`. Either one sets `MIDDEN_PUBLIC_ORIGIN` and `MIDDEN_TRUST_PROXY` for you. If traffic arrives some other way, set `publicOrigin` and `trustProxy` yourself, because live updates fail their origin check otherwise.

Your proxy has to allow two things:

- **WebSockets on `/api/ws`, held open for a long time.** Most controllers pass the upgrade by default but time out idle connections.
- **Uploads up to `config.maxUploadMb`.** Many controllers have a much lower default body size.

With ingress-nginx, for example:

```yaml
ingress:
  annotations:
    nginx.ingress.kubernetes.io/proxy-body-size: 25m
    nginx.ingress.kubernetes.io/proxy-read-timeout: '3600'
    nginx.ingress.kubernetes.io/proxy-send-timeout: '3600'
```

## Storage

The volume is the whole installation, so choose it with care:

- **Use block storage.** SQLite depends on file locking that many NFS setups get wrong, and a bad implementation can corrupt the database. This rules out most `ReadWriteMany` storage classes.
- **Plan for the size.** A /16 scan writes a few hundred megabytes, and each case can hold `config.caseQuotaMb` of attachments. Start with more than the default 20 GB if you expect either.
- **The volume outlives the chart.** `helm uninstall` leaves it in place so that removing the chart can't destroy evidence. Delete the claim yourself when you really mean to.

## Single sign-on

Put the client secret in a Kubernetes secret, then:

```yaml
oidc:
  issuer: https://idp.corp.example/realms/ir
  clientId: midden
  existingSecret: midden-oidc # with a `client-secret` key
```

Register `https://<your host>/api/auth/oidc/callback` as the redirect URI. The rest works as described under [single sign-on](deploy.md#single-sign-on).

## Backup and upgrade

Take a consistent copy before every upgrade:

```bash
kubectl exec -n midden deploy/midden -- node /app/dist/main.js backup /data/midden-backup.db
kubectl cp -n midden "$(kubectl get pod -n midden -l app.kubernetes.io/name=midden \
  -o jsonpath='{.items[0].metadata.name}')":/data/midden-backup.db ./midden-backup.db
```

That copies the database. Attachments and raw scans live in `/data/blobs`, so a volume snapshot is the better backup if your storage supports one.

Then upgrade. Midden applies database migrations when it starts:

```bash
helm upgrade midden oci://ghcr.io/jacstrong/midden/charts/midden \
  --namespace midden --version <new version> --reuse-values
```

Migrations only run forward, so rolling back to an older version means restoring the backup too. `helm rollback` alone isn't enough.

## Security

By default the pod runs as a non-root user with a read-only root filesystem, no added capabilities and no Kubernetes API token. Midden needs no outbound access unless you use single sign-on. To limit who can reach it, set `networkPolicy.enabled` and list your ingress controller in `networkPolicy.from`.
