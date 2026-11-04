#!/bin/sh
# Check or package the Helm chart. POSIX sh, so it runs in the alpine/helm image GitLab uses.
#   ci-chart.sh check
#   ci-chart.sh package <version> [oci://registry/path]
set -eu
cd "$(dirname "$0")/.."
CHART=charts/midden

fails_with() { # <expected message> <helm template args...>
  expected="$1"
  shift
  if out="$(helm template t "$CHART" "$@" 2>&1)"; then
    echo "expected the chart to refuse: $*" >&2
    exit 1
  fi
  case "$out" in
    *"$expected"*) ;;
    *)
      echo "wanted an error containing '$expected', got: $out" >&2
      exit 1
      ;;
  esac
}

has() { # <rendered> <text>
  case "$1" in
    *"$2"*) ;;
    *)
      echo "rendered chart is missing: $2" >&2
      exit 1
      ;;
  esac
}

case "${1:-}" in
  check)
    helm lint --strict "$CHART"
    plain="$(helm template t "$CHART")"
    has "$plain" 'replicas: 1'
    has "$plain" 'type: Recreate'
    has "$plain" 'helm.sh/resource-policy: keep'
    has "$plain" 'readOnlyRootFilesystem: true'
    has "$plain" 'MIDDEN_TRUST_PROXY'
    # A Service named midden would otherwise set MIDDEN_PORT to tcp://... and stop the server.
    named="$(helm template midden "$CHART")"
    has "$named" 'name: midden
'
    has "$named" 'enableServiceLinks: false'
    ingress="$(helm template t "$CHART" --set ingress.enabled=true \
      --set ingress.host=midden.corp.example --set ingress.tlsSecretName=midden-tls)"
    has "$ingress" 'kind: Ingress'
    has "$ingress" 'value: "https://midden.corp.example"'
    route="$(helm template t "$CHART" --set httpRoute.enabled=true \
      --set httpRoute.host=midden.corp.example --set 'httpRoute.parentRefs[0].name=gw')"
    has "$route" 'kind: HTTPRoute'
    has "$route" 'value: "https://midden.corp.example"'
    sso="$(helm template t "$CHART" --set oidc.issuer=https://idp.example --set oidc.clientId=m \
      --set oidc.existingSecret=s --set admin.existingSecret=a)"
    has "$sso" 'MIDDEN_OIDC_CLIENT_SECRET'
    has "$sso" 'MIDDEN_ADMIN_PASSWORD'
    pinned="$(helm template t "$CHART" --set image.digest=sha256:0000000000000000000000000000000000000000000000000000000000000000)"
    has "$pinned" 'midden@sha256:0000'
    helm template t "$CHART" --set networkPolicy.enabled=true --set persistence.existingClaim=c >/dev/null
    fails_with 'replicaCount' --set replicaCount=3
    fails_with 'autoscaling' --set autoscaling.enabled=true
    fails_with 'oidc.issuer needs' --set oidc.issuer=https://idp.example
    fails_with 'parentRefs' --set httpRoute.enabled=true
    echo 'chart: ok'
    ;;
  package)
    VERSION="${2:?version}"
    REGISTRY="${3:-}"
    # A chart version must be full semver, but tags have looked like v1.2.
    case "$VERSION" in
      *.*.*) CHART_VERSION="$VERSION" ;;
      *.*) CHART_VERSION="$VERSION.0" ;;
      *) CHART_VERSION="$VERSION.0.0" ;;
    esac
    mkdir -p release
    helm package "$CHART" --version "$CHART_VERSION" --app-version "$VERSION" --destination release
    TGZ="release/midden-$CHART_VERSION.tgz"
    if [ -f release/SHA256SUMS ]; then
      (cd release && sha256sum "midden-$CHART_VERSION.tgz" >> SHA256SUMS)
    fi
    if [ -n "$REGISTRY" ]; then helm push "$TGZ" "$REGISTRY"; fi
    ;;
  *)
    echo 'usage: ci-chart.sh check | package <version> [oci://registry/path]' >&2
    exit 2
    ;;
esac
