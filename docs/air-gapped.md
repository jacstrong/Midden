# Installing without internet access

Midden makes no outbound connections unless you configure single sign-on, so it runs on an isolated network with nothing extra. You only need to carry the files across. For a laptop or a single analyst, the [standalone `.html` file](deploy.md#no-server-at-all) is simpler still.

## On a connected machine

Pull the image for the architecture you're installing on, `linux/amd64` or `linux/arm64`, and save it to a file:

```bash
docker pull --platform linux/amd64 ghcr.io/jacstrong/midden:1.3.0
docker save ghcr.io/jacstrong/midden:1.3.0 -o midden-1.3.0-amd64.tar
```

Download the other files you want from the [release](https://github.com/jacstrong/Midden/releases):

- `SHA256SUMS`, to check the files on the other side.
- `midden-server-<version>.cdx.json`, the [SBOM](auditing.md), if your review process needs one.
- `midden-<version>.tgz`, the Helm chart, if you're installing on [Kubernetes](kubernetes.md).
- `midden-standalone-<version>.html`, for anyone working without the server.

The checksums cover the release files but not the image tar, since `docker save` makes that file on your machine. Make a checksum for it to carry across too:

```bash
sha256sum midden-1.3.0-amd64.tar > midden-image.sha256
```

Your transfer process may also ask for the image to be scanned. See [checking for known vulnerabilities](auditing.md#checking-for-known-vulnerabilities).

## On the isolated network

Check what arrived, then load the image:

```bash
sha256sum --check --ignore-missing SHA256SUMS
sha256sum --check midden-image.sha256
docker load -i midden-1.3.0-amd64.tar
```

Then run it with the [quick start](deploy.md#quick-start), using the version you loaded rather than `latest`:

```bash
docker run -d --name midden \
  -p 8080:8080 \
  -v "$PWD/midden-data:/data" \
  -e MIDDEN_ADMIN_USER=admin \
  ghcr.io/jacstrong/midden:1.3.0
```

For HTTPS with no public certificate authority, use [Compose with Caddy's private CA](https-proxy.md#choosing-a-certificate), or point Midden at your own certificate with `MIDDEN_TLS_CERT` and `MIDDEN_TLS_KEY`. The Compose route needs the Caddy image carried across as well, in the same way.

## With a private registry

If the network has a registry, push the image there so that other machines can pull it:

```bash
docker tag ghcr.io/jacstrong/midden:1.3.0 registry.hunt.lan/midden:1.3.0
docker push registry.hunt.lan/midden:1.3.0
```

On Kubernetes, install the chart from its file and point it at your registry:

```bash
helm install midden ./midden-1.3.0.tgz \
  --namespace midden --create-namespace \
  --set image.repository=registry.hunt.lan/midden \
  --set image.tag=1.3.0
```

Add `imagePullSecrets` if your registry requires credentials. To pin the exact image you reviewed, set `image.digest` instead of `image.tag`.

## Upgrading

Repeat the same steps with the new version. [Take a backup](deploy.md#backup-and-restore) first, because migrations only run forward. Midden applies them when it starts, and needs no network access to do so.

## What won't work offline

- **Single sign-on** needs to reach your identity provider, so that provider has to be on the isolated network too.
- **AI agents** connect to Midden over [MCP](mcp.md), so the agent and its model have to be reachable from the isolated network. A hosted model would mean case data leaving it.
