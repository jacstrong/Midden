{{- define "midden.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "midden.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "midden.labels" -}}
{{ include "midden.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "midden.image" -}}
{{- if .Values.image.digest -}}
{{ .Values.image.repository }}@{{ .Values.image.digest }}
{{- else -}}
{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}
{{- end -}}
{{- end -}}

{{- define "midden.claimName" -}}
{{- .Values.persistence.existingClaim | default (printf "%s-data" (include "midden.fullname" .)) -}}
{{- end -}}

{{/* The public URL: as configured, or worked out from the ingress or route. */}}
{{- define "midden.publicOrigin" -}}
{{- if .Values.publicOrigin -}}
{{ .Values.publicOrigin }}
{{- else if .Values.ingress.enabled -}}
{{ ternary "https" "http" (not (empty .Values.ingress.tlsSecretName)) }}://{{ .Values.ingress.host }}
{{- else if .Values.httpRoute.enabled -}}
{{ ternary "https" "http" .Values.httpRoute.https }}://{{ .Values.httpRoute.host }}
{{- end -}}
{{- end -}}

{{- define "midden.trustProxy" -}}
{{- if kindIs "invalid" .Values.trustProxy -}}
{{ or .Values.ingress.enabled .Values.httpRoute.enabled }}
{{- else -}}
{{ .Values.trustProxy }}
{{- end -}}
{{- end -}}
